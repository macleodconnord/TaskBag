import { DIGEST_MODES } from '@app/shared';
import { and, desc, eq, inArray, isNull, lt, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { db } from '../../db/client';
import { notifications, workspaces } from '../../db/schema';
import { DEFAULT_TZ } from '../../lib/dates';
import { NotFound } from '../../lib/errors';
import { auth, parse } from '../../lib/http';
import { sendMail } from './email';
import {
  builtinDefaults, invalidateWorkspaceDefaults, mergeMatrix, PREF_CHANNELS, PREF_EVENTS, setUserPref, userPrefs, workspaceDefaults,
} from './prefs';
import { renderNotifications } from './render';
import { notSnoozed, snoozedNow } from './service';

const listQuery = z.object({
  filter: z.enum(['unread', 'all', 'snoozed']).default('all'),
  type: z.string().optional(),
  before: z.string().datetime().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
const idParams = z.object({ id: z.string().uuid() });
const cellSchema = z.object({ enabled: z.boolean(), digest: z.enum(DIGEST_MODES) });
const prefSchema = z.object({
  eventType: z.enum(PREF_EVENTS),
  channel: z.enum(PREF_CHANNELS),
  /** null resets to the workspace default */
  value: cellSchema.nullable(),
});
const defaultsSchema = z.record(z.string(), z.object({ in_app: cellSchema.optional(), email: cellSchema.optional() }));

export default async function notificationRoutes(app: FastifyInstance) {
  // ── inbox ──
  app.get('/', async (req) => {
    const { user, access } = auth(req);
    const q = parse(listQuery, req.query);
    const now = new Date();
    const rows = await db.select().from(notifications).where(and(
      eq(notifications.userId, user.id),
      q.filter === 'snoozed' ? snoozedNow(now) : and(isNull(notifications.clearedAt), notSnoozed(now)),
      q.filter === 'unread' ? isNull(notifications.readAt) : undefined,
      q.type ? inArray(notifications.eventType, q.type.split(',')) : undefined,
      q.before ? lt(notifications.createdAt, new Date(q.before)) : undefined,
    )).orderBy(desc(notifications.createdAt)).limit(q.limit + 1);
    const items = await renderNotifications(rows.slice(0, q.limit), access, user.timezone ?? DEFAULT_TZ);
    return { items, hasMore: rows.length > q.limit };
  });

  app.get('/unread-count', async (req) => {
    const { user } = auth(req);
    const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(notifications)
      .where(and(eq(notifications.userId, user.id), isNull(notifications.readAt), isNull(notifications.clearedAt), notSnoozed()));
    return { count: n };
  });

  const mine = async (userId: string, id: string) => {
    const [n] = await db.select({ id: notifications.id }).from(notifications).where(and(eq(notifications.id, id), eq(notifications.userId, userId)));
    if (!n) throw new NotFound();
  };

  app.post('/:id/read', async (req) => {
    const { user } = auth(req);
    const { id } = parse(idParams, req.params);
    await mine(user.id, id);
    await db.update(notifications).set({ readAt: sql`coalesce(${notifications.readAt}, now())` }).where(eq(notifications.id, id));
    return { ok: true };
  });

  app.post('/:id/unread', async (req) => {
    const { user } = auth(req);
    const { id } = parse(idParams, req.params);
    await mine(user.id, id);
    await db.update(notifications).set({ readAt: null }).where(eq(notifications.id, id));
    return { ok: true };
  });

  app.post('/:id/clear', async (req) => {
    const { user } = auth(req);
    const { id } = parse(idParams, req.params);
    await mine(user.id, id);
    await db.update(notifications).set({ clearedAt: new Date(), readAt: sql`coalesce(${notifications.readAt}, now())` }).where(eq(notifications.id, id));
    return { ok: true };
  });

  app.post('/:id/snooze', async (req) => {
    const { user } = auth(req);
    const { id } = parse(idParams, req.params);
    const { until } = parse(z.object({ until: z.string().datetime().nullable() }), req.body);
    await mine(user.id, id);
    // snoozed items come back unread when they wake up
    await db.update(notifications).set({ snoozedUntil: until ? new Date(until) : null, ...(until ? { readAt: null } : {}) }).where(eq(notifications.id, id));
    return { ok: true };
  });

  app.post('/read-all', async (req) => {
    const { user } = auth(req);
    const { type } = parse(z.object({ type: z.string().optional() }), req.body ?? {});
    await db.update(notifications).set({ readAt: new Date() }).where(and(
      eq(notifications.userId, user.id), isNull(notifications.readAt), isNull(notifications.clearedAt), notSnoozed(),
      type ? inArray(notifications.eventType, type.split(',')) : undefined,
    ));
    return { ok: true };
  });

  app.post('/clear-read', async (req) => {
    const { user } = auth(req);
    await db.update(notifications).set({ clearedAt: new Date() }).where(and(
      eq(notifications.userId, user.id), isNull(notifications.clearedAt), sql`${notifications.readAt} is not null`, notSnoozed(),
    ));
    return { ok: true };
  });

  // ── preferences ──
  app.get('/preferences', async (req) => {
    const { user, access } = auth(req);
    const { matrix, overridden } = await userPrefs(user.id);
    const events = PREF_EVENTS.filter((e) => e !== 'admin_alert' || access.isAdmin);
    return {
      events,
      channels: PREF_CHANNELS,
      matrix: Object.fromEntries(events.map((e) => [e, Object.fromEntries(PREF_CHANNELS.map((c) => [c, { ...matrix[e][c], overridden: overridden.has(`${e}:${c}`) }]))])),
      defaults: await workspaceDefaults(),
      isAdmin: access.isAdmin,
    };
  });

  app.put('/preferences', async (req) => {
    const { user } = auth(req);
    const input = parse(prefSchema, req.body);
    await setUserPref(user.id, input.eventType, input.channel, input.value);
    return { ok: true };
  });

  app.delete('/preferences', async (req) => {
    const { user } = auth(req);
    for (const e of PREF_EVENTS) for (const c of PREF_CHANNELS) await setUserPref(user.id, e, c, null);
    return { ok: true };
  });

  // ── workspace defaults (admin) ──
  app.get('/defaults', async (req) => {
    auth(req);
    return { defaults: await workspaceDefaults(), builtin: builtinDefaults() };
  });

  app.put('/defaults', async (req) => {
    const { access } = auth(req);
    access.requireAdmin();
    const input = parse(defaultsSchema, req.body);
    const merged = mergeMatrix(await workspaceDefaults(), input);
    const [ws] = await db.select().from(workspaces).limit(1);
    await db.update(workspaces).set({ settings: { ...ws.settings, notificationDefaults: merged } }).where(eq(workspaces.id, ws.id));
    invalidateWorkspaceDefaults();
    return { defaults: merged };
  });

  /** Admin: send a test email to yourself right now (bypasses the outbox). */
  app.post('/test-email', async (req) => {
    const { user, access } = auth(req);
    access.requireAdmin();
    await sendMail({
      to: user.email,
      subject: 'Test email',
      text: 'SMTP is working.',
      html: '<p style="font-family:sans-serif">SMTP is working.</p>',
    });
    return { ok: true };
  });
}
