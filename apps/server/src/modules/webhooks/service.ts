import { randomUUID } from 'node:crypto';
import { can } from '@app/shared';
import { and, asc, eq, lte, sql } from 'drizzle-orm';
import { db } from '../../db/client';
import { comments, lists, spaces, statuses, tasks, webhookDeliveries, webhookSubscriptions } from '../../db/schema';
import { env } from '../../env';
import { accessForUser } from '../../lib/access';
import { decrypt, hmacSha256 } from '../../lib/crypto';
import type { EventEnvelope } from '../../lib/events';
import { log } from '../../lib/log';

export const MAX_ATTEMPTS = 8;
type Sub = typeof webhookSubscriptions.$inferSelect;

/** Exponential backoff with jitter: 30s, 1m, 2m, 4m … capped at 2h. */
export const backoffMs = (attempts: number) => Math.min(2 * 3600_000, 30_000 * 2 ** Math.max(0, attempts - 1)) + Math.floor(Math.random() * 5_000);

const taskIdOf = (e: EventEnvelope): string | null => {
  const d = e.data as { taskId?: string | null };
  return d.taskId ?? null;
};

/** Task + location + status name; includes soft-deleted rows (task.deleted events). */
async function loadTask(taskId: string) {
  const [row] = await db.select({
    t: tasks, spaceId: lists.spaceId, folderId: lists.folderId, listName: lists.name, statusName: statuses.name, prefix: spaces.keyPrefix,
  }).from(tasks)
    .innerJoin(lists, eq(lists.id, tasks.listId))
    .innerJoin(spaces, eq(spaces.id, lists.spaceId))
    .leftJoin(statuses, eq(statuses.id, tasks.statusId))
    .where(eq(tasks.id, taskId));
  return row ?? null;
}
type LoadedTask = NonNullable<Awaited<ReturnType<typeof loadTask>>>;

const inScope = (s: Sub, t: LoadedTask) =>
  s.scopeType === 'workspace' || !s.scopeId
  || (s.scopeType === 'space' && t.spaceId === s.scopeId)
  || (s.scopeType === 'folder' && t.folderId === s.scopeId)
  || (s.scopeType === 'list' && t.t.listId === s.scopeId);

/** Can the subscription's acting user view this task right now? (permissions.md §6.5) */
async function actingUserCanView(s: Sub, aclScopeId: string) {
  const access = await accessForUser(s.actingUserId);
  if (!access || !access.user.isActive) return false;
  return can(await access.levelOfScope(aclScopeId), 'view');
}

const appUrl = () => env.PUBLIC_URL.replace(/\/$/, '');

/** Payload: the event plus a small task summary (only ever built for tasks the acting user can view). */
async function buildPayload(e: EventEnvelope, t: LoadedTask) {
  const data = { ...(e.data as Record<string, unknown>) };
  let comment: Record<string, unknown> | undefined;
  if (e.type === 'comment.created') {
    const [c] = await db.select({ id: comments.id, bodyText: comments.bodyText, authorId: comments.authorId, createdAt: comments.createdAt, parentId: comments.parentId })
      .from(comments).where(eq(comments.id, (e.data as { commentId: string }).commentId));
    comment = c ? { ...c } : undefined;
  }
  return {
    id: e.id,
    type: e.type,
    occurredAt: e.at,
    data,
    task: {
      id: t.t.id, key: t.t.key, shortId: t.t.shortId, name: t.t.name, url: `${appUrl()}/t/${t.t.key}`,
      listId: t.t.listId, listName: t.listName, spaceId: t.spaceId, folderId: t.folderId,
      status: t.statusName, priority: t.t.priority, dueAt: t.t.dueAt, completedAt: t.t.completedAt, deleted: !!t.t.deletedAt,
    },
    ...(comment ? { comment } : {}),
  };
}

/** Domain event fan-out: one pending delivery per matching subscription whose acting user can view the task. */
export async function onDomainEvent(e: EventEnvelope) {
  const subs = await db.select().from(webhookSubscriptions).where(eq(webhookSubscriptions.enabled, true));
  const matching = subs.filter((s) => !s.eventTypes.length || s.eventTypes.includes(e.type));
  if (!matching.length) return;
  const taskId = taskIdOf(e);
  if (!taskId) return; // doc-only events aren't exposed to webhooks
  const t = await loadTask(taskId);
  if (!t) return;
  let payload: Awaited<ReturnType<typeof buildPayload>> | null = null;
  for (const s of matching) {
    if (!inScope(s, t)) continue;
    if (!(await actingUserCanView(s, t.t.aclScopeId))) continue; // no delivery row at all
    payload ??= await buildPayload(e, t);
    await db.insert(webhookDeliveries).values({ subscriptionId: s.id, eventId: e.id, eventType: e.type, payload }).onConflictDoNothing();
  }
}

/** "Send test": a signed `webhook.test` event (not ACL-filtered — it carries no workspace data). */
export async function queueTest(subId: string) {
  const id = randomUUID();
  const payload = { id, type: 'webhook.test', occurredAt: new Date().toISOString(), data: { message: 'Test event from Project', subscriptionId: subId } };
  const [d] = await db.insert(webhookDeliveries).values({ subscriptionId: subId, eventId: id, eventType: 'webhook.test', payload }).returning();
  return d;
}

/** POST one delivery. Returns the updated row. */
export async function attemptDelivery(d: typeof webhookDeliveries.$inferSelect) {
  const [s] = await db.select().from(webhookSubscriptions).where(eq(webhookSubscriptions.id, d.subscriptionId));
  if (!s) return null;
  const attempts = d.attempts + 1;
  const finish = async (ok: boolean, httpStatus: number | null, excerpt: string, final = false) => {
    const failed = !ok && (final || attempts >= MAX_ATTEMPTS);
    const [row] = await db.update(webhookDeliveries).set({
      status: ok ? 'succeeded' : failed ? 'failed' : 'pending',
      httpStatus, attempts, responseExcerpt: excerpt.slice(0, 500),
      nextAttemptAt: ok || failed ? new Date() : new Date(Date.now() + backoffMs(attempts)),
    }).where(eq(webhookDeliveries.id, d.id)).returning();
    return row;
  };

  // re-check visibility at send time (access may have been revoked since the event)
  const p = d.payload as { task?: { id: string } };
  if (p.task?.id) {
    const [t] = await db.select({ scope: tasks.aclScopeId }).from(tasks).where(eq(tasks.id, p.task.id));
    if (!t || !(await actingUserCanView(s, t.scope))) return finish(false, null, 'Not sent: the acting user can no longer view this task', true);
  }

  const body = JSON.stringify(d.payload);
  let secret: string;
  try {
    secret = decrypt(s.secretEnc);
  } catch {
    return finish(false, null, 'Could not decrypt the signing secret', true);
  }
  try {
    const res = await fetch(s.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'user-agent': 'project-webhooks/1',
        'x-signature': `sha256=${hmacSha256(secret, body)}`,
        'x-webhook-event': d.eventType,
        'x-webhook-delivery': d.id,
        'x-webhook-attempt': String(attempts),
      },
      body,
      redirect: 'manual',
      signal: AbortSignal.timeout(10_000),
    });
    const text = await res.text().catch(() => '');
    return finish(res.ok, res.status, text || res.statusText);
  } catch (err) {
    return finish(false, null, err instanceof Error ? (err.cause instanceof Error ? `${err.message}: ${err.cause.message}` : err.message) : String(err));
  }
}

/** Job: drain due deliveries. */
export async function deliverDue() {
  const due = await db.select().from(webhookDeliveries)
    .where(and(eq(webhookDeliveries.status, 'pending'), lte(webhookDeliveries.nextAttemptAt, new Date())))
    .orderBy(asc(webhookDeliveries.nextAttemptAt)).limit(25);
  let ok = 0;
  for (const d of due) {
    try {
      const r = await attemptDelivery(d);
      if (r?.status === 'succeeded') ok++;
    } catch (err) {
      log.error({ err, delivery: d.id }, 'webhook delivery crashed');
    }
  }
  return { attempted: due.length, ok };
}

export async function pruneDeliveries() {
  await db.execute(sql`delete from webhook_deliveries where created_at < now() - interval '30 days' and status <> 'pending'`);
}
