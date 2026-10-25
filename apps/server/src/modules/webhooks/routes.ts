import { WEBHOOK_EVENT_TYPES, webhookSubscriptionSchema } from '@app/shared';
import { and, desc, eq, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { db } from '../../db/client';
import { folders, lists, spaces, users, webhookDeliveries, webhookSubscriptions } from '../../db/schema';
import { encrypt, randomToken } from '../../lib/crypto';
import { NotFound, Validation } from '../../lib/errors';
import { auth, parse, type Params } from '../../lib/http';
import { attemptDelivery, queueTest } from './service';

const newSecret = () => `whsec_${randomToken(24)}`;

async function validateRefs(input: { scopeType?: string; scopeId?: string | null; actingUserId?: string }) {
  if (input.actingUserId) {
    const [u] = await db.select({ id: users.id, isActive: users.isActive }).from(users).where(eq(users.id, input.actingUserId));
    if (!u) throw new Validation('Acting user not found');
  }
  if (input.scopeType && input.scopeType !== 'workspace') {
    if (!input.scopeId) throw new Validation('Choose a Space, Folder or List for the scope');
    const table = input.scopeType === 'space' ? spaces : input.scopeType === 'folder' ? folders : lists;
    const [row] = await db.select({ id: table.id }).from(table).where(eq(table.id, input.scopeId));
    if (!row) throw new Validation('Scope not found');
  }
}

/** Subscription as returned to admins: never the secret. */
async function listSubs(id?: string) {
  const rows = await db.select({
    s: webhookSubscriptions,
    actingUser: { id: users.id, displayName: users.displayName },
    pending: sql<number>`(select count(*)::int from webhook_deliveries d where d.subscription_id = ${webhookSubscriptions.id} and d.status = 'pending')`,
    failed24h: sql<number>`(select count(*)::int from webhook_deliveries d where d.subscription_id = ${webhookSubscriptions.id} and d.status = 'failed' and d.created_at > now() - interval '24 hours')`,
    lastDelivery: sql<{ status: string; http_status: number | null; created_at: string } | null>`(select json_build_object('status', d.status, 'httpStatus', d.http_status, 'createdAt', d.created_at) from webhook_deliveries d where d.subscription_id = ${webhookSubscriptions.id} order by d.created_at desc limit 1)`,
  }).from(webhookSubscriptions).leftJoin(users, eq(users.id, webhookSubscriptions.actingUserId))
    .where(id ? eq(webhookSubscriptions.id, id) : sql`true`)
    .orderBy(webhookSubscriptions.createdAt);
  return rows.map(({ s, ...rest }) => {
    const { secretEnc: _secret, ...sub } = s;
    return { ...sub, ...rest };
  });
}

/** /api/webhooks — outbound webhook subscriptions (admins only). */
export default async function webhooksRoutes(app: FastifyInstance) {
  app.addHook('preHandler', async (req) => auth(req).access.requireAdmin());

  app.get('/meta', async () => ({ eventTypes: WEBHOOK_EVENT_TYPES }));

  app.get('/', async () => listSubs());

  app.post('/subscriptions', async (req) => {
    const input = parse(webhookSubscriptionSchema, req.body);
    await validateRefs(input);
    const secret = newSecret();
    const [row] = await db.insert(webhookSubscriptions).values({
      ...input, scopeId: input.scopeType === 'workspace' ? null : input.scopeId ?? null, secretEnc: encrypt(secret),
    }).returning({ id: webhookSubscriptions.id });
    const [sub] = await listSubs(row.id);
    // shown once; only the encrypted form is stored
    return { subscription: sub, secret };
  });

  app.patch<{ Params: Params<'id'> }>('/subscriptions/:id', async (req) => {
    const input = parse(webhookSubscriptionSchema.partial(), req.body);
    await validateRefs(input);
    const set: Partial<typeof webhookSubscriptions.$inferInsert> = { ...input };
    if (input.scopeType === 'workspace') set.scopeId = null;
    const [row] = await db.update(webhookSubscriptions).set(set).where(eq(webhookSubscriptions.id, req.params.id)).returning({ id: webhookSubscriptions.id });
    if (!row) throw new NotFound();
    return (await listSubs(row.id))[0];
  });

  app.post<{ Params: Params<'id'> }>('/subscriptions/:id/rotate-secret', async (req) => {
    const secret = newSecret();
    const [row] = await db.update(webhookSubscriptions).set({ secretEnc: encrypt(secret) }).where(eq(webhookSubscriptions.id, req.params.id)).returning({ id: webhookSubscriptions.id });
    if (!row) throw new NotFound();
    return { secret };
  });

  app.delete<{ Params: Params<'id'> }>('/subscriptions/:id', async (req) => {
    await db.delete(webhookSubscriptions).where(eq(webhookSubscriptions.id, req.params.id));
    return { ok: true };
  });

  /** "Send test": queue a signed test event and try it right away. */
  app.post<{ Params: Params<'id'> }>('/subscriptions/:id/test', async (req) => {
    const [s] = await db.select({ id: webhookSubscriptions.id }).from(webhookSubscriptions).where(eq(webhookSubscriptions.id, req.params.id));
    if (!s) throw new NotFound();
    const d = await queueTest(s.id);
    const result = await attemptDelivery(d);
    return result ?? d;
  });

  app.get<{ Params: Params<'id'>; Querystring: { status?: string; limit?: string } }>('/subscriptions/:id/deliveries', async (req) => {
    const q = parse(z.object({ status: z.enum(['pending', 'succeeded', 'failed']).optional(), limit: z.coerce.number().int().min(1).max(200).default(50) }), req.query);
    return db.select().from(webhookDeliveries)
      .where(and(eq(webhookDeliveries.subscriptionId, req.params.id), q.status ? eq(webhookDeliveries.status, q.status) : sql`true`))
      .orderBy(desc(webhookDeliveries.createdAt)).limit(q.limit);
  });

  /** Retry a failed (or pending) delivery now. */
  app.post<{ Params: Params<'id'> }>('/deliveries/:id/retry', async (req) => {
    const [d] = await db.select().from(webhookDeliveries).where(eq(webhookDeliveries.id, req.params.id));
    if (!d) throw new NotFound();
    if (d.status === 'succeeded') throw new Validation('Already delivered');
    // a manual retry gets a fresh attempt budget
    const [reset] = await db.update(webhookDeliveries).set({ status: 'pending', attempts: 0, nextAttemptAt: new Date() }).where(eq(webhookDeliveries.id, d.id)).returning();
    return attemptDelivery(reset);
  });
}
