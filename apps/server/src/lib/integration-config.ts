import type { IntegrationKey } from '@app/shared';
import { and, eq } from 'drizzle-orm';
import { db, type Tx } from '../db/client';
import { integrations, integrationSecrets } from '../db/schema';
import { env } from '../env';
import { decrypt, encrypt } from './crypto';
import { log } from './log';

export interface IntegrationConfig {
  key: IntegrationKey;
  enabled: boolean;
  config: Record<string, unknown>;
  /** decrypted secrets, server-side only — never return these from the API */
  secrets: Record<string, string>;
}

const cache = new Map<string, IntegrationConfig>();
const listeners: Array<(key: IntegrationKey) => void> = [];

/** Cached read of an integration's settings; invalidated on save (single process, so no pub/sub needed). */
export async function getIntegrationConfig(key: IntegrationKey): Promise<IntegrationConfig> {
  const hit = cache.get(key);
  if (hit) return hit;
  const [row] = await db.select().from(integrations).where(eq(integrations.key, key));
  const secretRows = await db.select().from(integrationSecrets).where(eq(integrationSecrets.integrationKey, key));
  const secrets: Record<string, string> = {};
  for (const s of secretRows) {
    try {
      secrets[s.name] = decrypt(s.valueEnc);
    } catch (err) {
      log.error({ err, key, name: s.name }, 'could not decrypt integration secret (APP_ENCRYPTION_KEY changed?)');
    }
  }
  const cfg: IntegrationConfig = { key, enabled: row?.enabled ?? false, config: row?.config ?? {}, secrets };
  cache.set(key, cfg);
  return cfg;
}

export function invalidateIntegrationConfig(key: IntegrationKey) {
  cache.delete(key);
  for (const l of listeners) l(key);
}
export const onIntegrationConfigChange = (l: (key: IntegrationKey) => void) => listeners.push(l);

export async function saveIntegration(
  tx: Tx,
  key: IntegrationKey,
  patch: { enabled?: boolean; config?: Record<string, unknown> },
  actorId: string | null,
) {
  const [existing] = await tx.select().from(integrations).where(eq(integrations.key, key));
  if (existing) {
    await tx.update(integrations).set({
      ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
      ...(patch.config ? { config: patch.config } : {}),
      updatedBy: actorId,
    }).where(eq(integrations.key, key));
  } else {
    await tx.insert(integrations).values({ key, enabled: patch.enabled ?? false, config: patch.config ?? {}, updatedBy: actorId });
  }
  invalidateIntegrationConfig(key);
}

export async function setSecret(tx: Tx, key: IntegrationKey, name: string, value: string | null, actorId: string | null, expiresAt?: Date | null) {
  if (value === null) {
    await tx.delete(integrationSecrets).where(and(eq(integrationSecrets.integrationKey, key), eq(integrationSecrets.name, name)));
  } else {
    await tx.insert(integrationSecrets)
      .values({ integrationKey: key, name, valueEnc: encrypt(value), updatedBy: actorId, expiresAt: expiresAt ?? null })
      .onConflictDoUpdate({
        target: [integrationSecrets.integrationKey, integrationSecrets.name],
        set: { valueEnc: encrypt(value), updatedBy: actorId, updatedAt: new Date(), expiryNotified: null, ...(expiresAt !== undefined ? { expiresAt } : {}) },
      });
  }
  invalidateIntegrationConfig(key);
}

/** First boot only: copy Entra/SMTP values from env into the GUI-managed settings. */
export async function seedIntegrationsFromEnv() {
  const seed = async (key: IntegrationKey, config: Record<string, unknown>, secrets: Record<string, string | undefined>) => {
    const [row] = await db.select().from(integrations).where(eq(integrations.key, key));
    if (row) return;
    await db.transaction(async (tx) => {
      await saveIntegration(tx, key, { enabled: true, config }, null);
      for (const [n, v] of Object.entries(secrets)) if (v) await setSecret(tx, key, n, v, null);
    });
    log.info({ key }, 'seeded integration settings from env');
  };
  if (env.ENTRA_TENANT_ID && env.ENTRA_CLIENT_ID) {
    await seed('entra', { tenantId: env.ENTRA_TENANT_ID, clientId: env.ENTRA_CLIENT_ID, defaultRole: 'member', syncGroups: true }, { clientSecret: env.ENTRA_CLIENT_SECRET });
  }
  if (env.SMTP_HOST) {
    await seed('smtp', { host: env.SMTP_HOST, port: env.SMTP_PORT ?? 25, secure: 'none', from: env.SMTP_FROM ?? 'pm@localhost' }, {});
  }
}
