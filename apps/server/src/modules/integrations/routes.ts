import { INTEGRATION_DESCRIPTORS, INTEGRATION_KEYS, integrationConfigSchema, secretFieldsOf, type IntegrationKey } from '@app/shared';
import { and, desc, eq, gt, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { db } from '../../db/client';
import { integrations, integrationSecrets, integrationSyncLogs, users } from '../../db/schema';
import { NotFound, Validation } from '../../lib/errors';
import { auth, parse } from '../../lib/http';
import { getIntegrationConfig, invalidateIntegrationConfig, saveIntegration, setSecret } from '../../lib/integration-config';
import { log } from '../../lib/log';
import { runTx } from '../../lib/tx';
import { giteaWebhookUrl } from '../gitea/client';
import { setHealth } from './health';
import { runIntegrationTest } from './tests';

const keySchema = z.enum(INTEGRATION_KEYS);
const DAY = 86_400_000;

type Health = 'ok' | 'degraded' | 'down' | 'unknown' | 'disabled';

/** Everything the admin page shows for one integration. Never includes secret values. */
async function describe(key: IntegrationKey) {
  const [row] = await db.select({ i: integrations, by: { id: users.id, displayName: users.displayName } })
    .from(integrations).leftJoin(users, eq(users.id, integrations.updatedBy)).where(eq(integrations.key, key));
  const secretRows = await db.select({
    name: integrationSecrets.name, updatedAt: integrationSecrets.updatedAt, expiresAt: integrationSecrets.expiresAt,
    by: { id: users.id, displayName: users.displayName },
  }).from(integrationSecrets).leftJoin(users, eq(users.id, integrationSecrets.updatedBy)).where(eq(integrationSecrets.integrationKey, key));

  const secrets = secretFieldsOf(key).map((name) => {
    const s = secretRows.find((r) => r.name === name);
    return {
      name,
      set: !!s,
      masked: s ? '••••' : null,
      updatedAt: s?.updatedAt ?? null,
      updatedBy: s?.by?.id ? s.by : null,
      expiresAt: s?.expiresAt ?? null,
    };
  });

  // health = last run result, degraded by error rate over the last hour and by secret expiry
  const [rate] = await db.select({
    total: sql<number>`count(*)::int`,
    errors: sql<number>`count(*) filter (where ${integrationSyncLogs.status} = 'error')::int`,
  }).from(integrationSyncLogs)
    .where(and(eq(integrationSyncLogs.integrationKey, key), gt(integrationSyncLogs.startedAt, new Date(Date.now() - 3600_000))));
  const enabled = row?.i.enabled ?? false;
  let health: Health = row?.i.health ?? 'unknown';
  let detail = row?.i.healthDetail ?? null;
  const notes: string[] = [];
  if (rate.total >= 3 && rate.errors / rate.total > 0.5 && health === 'ok') {
    health = 'degraded';
    notes.push(`${rate.errors} of ${rate.total} runs failed in the last hour`);
  }
  for (const s of secrets) {
    if (!s.expiresAt) continue;
    const days = (s.expiresAt.getTime() - Date.now()) / DAY;
    if (days <= 0) {
      health = 'down';
      notes.push(`${s.name} expired on ${s.expiresAt.toISOString().slice(0, 10)}`);
    } else if (days <= 30) {
      if (health !== 'down') health = 'degraded';
      notes.push(`${s.name} expires in ${Math.ceil(days)} day(s)`);
    }
  }
  if (notes.length) detail = [...notes, detail].filter(Boolean).join(' · ');
  if (!enabled) health = 'disabled';

  return {
    key,
    enabled,
    config: row?.i.config ?? {},
    secrets,
    health,
    healthDetail: detail,
    lastSuccessAt: row?.i.lastSuccessAt ?? null,
    updatedAt: row?.i.updatedAt ?? null,
    updatedBy: row?.by?.id ? row.by : null,
    errorRate: rate,
    extra: key === 'gitea' ? { webhookUrl: giteaWebhookUrl() } : {},
  };
}

/** /api/integrations — Admin → Integrations & credentials (owners and admins only). */
export default async function integrationsRoutes(app: FastifyInstance) {
  app.addHook('preHandler', async (req) => auth(req).access.requireAdmin());

  app.get('/', async () => Promise.all(INTEGRATION_KEYS.map(describe)));

  app.get<{ Params: { key: string } }>('/:key', async (req) => describe(parse(keySchema, req.params.key)));

  app.put<{ Params: { key: string } }>('/:key', async (req) => {
    const { user } = auth(req);
    const key = parse(keySchema, req.params.key);
    const input = parse(z.object({ enabled: z.boolean().optional(), config: z.record(z.string(), z.unknown()).optional() }), req.body);
    let config: Record<string, unknown> | undefined;
    if (input.config) {
      const clean = parse(integrationConfigSchema(key), input.config) as Record<string, unknown>;
      const current = (await getIntegrationConfig(key)).config;
      config = { ...current };
      // keys sent explicitly replace the stored value; blank → removed
      for (const k of Object.keys(input.config)) {
        if (clean[k] === undefined) delete config[k];
        else config[k] = clean[k];
      }
    }
    await runTx((tx) => saveIntegration(tx, key, { enabled: input.enabled, config }, user.id));
    log.info({ key, actor: user.id, fields: input.config ? Object.keys(input.config) : [], enabled: input.enabled }, 'integration settings changed');
    return describe(key);
  });

  app.put<{ Params: { key: string; name: string } }>('/:key/secrets/:name', async (req) => {
    const { user } = auth(req);
    const key = parse(keySchema, req.params.key);
    const name = req.params.name;
    if (!secretFieldsOf(key).includes(name)) throw new NotFound('Unknown secret');
    const input = parse(z.object({
      value: z.string().min(1).max(10_000).nullable().optional(),
      expiresAt: z.string().datetime({ offset: true }).or(z.string().regex(/^\d{4}-\d{2}-\d{2}$/)).nullable().optional(),
    }), req.body);
    const expiresAt = input.expiresAt === undefined ? undefined : input.expiresAt ? new Date(input.expiresAt) : null;
    if (input.value === undefined) {
      if (expiresAt === undefined) throw new Validation('Nothing to change');
      const rows = await db.update(integrationSecrets).set({ expiresAt, expiryNotified: null, updatedBy: user.id })
        .where(and(eq(integrationSecrets.integrationKey, key), eq(integrationSecrets.name, name))).returning({ n: integrationSecrets.name });
      if (!rows.length) throw new Validation('Set the secret before its expiry date');
      invalidateIntegrationConfig(key);
    } else {
      await runTx(async (tx) => {
        // make sure the integrations row exists so "last changed by" etc. work
        await tx.insert(integrations).values({ key, enabled: false, config: {} }).onConflictDoNothing();
        await setSecret(tx, key, name, input.value ?? null, user.id, expiresAt);
      });
    }
    log.info({ key, secret: name, actor: user.id, cleared: input.value === null }, 'integration secret changed');
    return describe(key);
  });

  app.post<{ Params: { key: string } }>('/:key/test', async (req) => {
    const { user } = auth(req);
    const key = parse(keySchema, req.params.key);
    const started = new Date();
    const result = await runIntegrationTest(key, user).catch((err: unknown) => ({ ok: false, detail: err instanceof Error ? err.message : String(err), data: undefined }));
    await db.insert(integrationSyncLogs).values({
      integrationKey: key, jobName: 'test', status: result.ok ? 'ok' : 'error', startedAt: started, finishedAt: new Date(),
      error: result.ok ? null : result.detail.slice(0, 2000), stats: { by: user.displayName },
    });
    await setHealth(key, result.ok ? 'ok' : 'down', result.ok ? 'Connection test passed' : `Connection test failed: ${result.detail.split('\n')[0]}`, result.ok);
    return { ...result, testedAt: new Date(), label: INTEGRATION_DESCRIPTORS[key].testLabel };
  });

  app.get<{ Params: { key: string }; Querystring: { limit?: string } }>('/:key/logs', async (req) => {
    const key = parse(keySchema, req.params.key);
    const limit = Math.min(200, Math.max(1, Number(req.query.limit ?? 30) || 30));
    return db.select().from(integrationSyncLogs).where(eq(integrationSyncLogs.integrationKey, key)).orderBy(desc(integrationSyncLogs.startedAt)).limit(limit);
  });
}
