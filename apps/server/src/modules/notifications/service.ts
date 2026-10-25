import { and, eq, gt, inArray, isNotNull, isNull, lt, ne, or, sql } from 'drizzle-orm';
import { db } from '../../db/client';
import { docs, notifications, taskAssignees, tasks, users } from '../../db/schema';
import { accessForUser } from '../../lib/access';
import { addDays, DEFAULT_TZ, startOfDay } from '../../lib/dates';
import { on } from '../../lib/events';
import { log } from '../../lib/log';
import { notificationChannels } from './channels';
import { userPrefs, workspaceTimezone, type ChannelPref } from './prefs';

export interface NotifyInput {
  userId: string;
  eventType: string;
  taskId?: string | null;
  docId?: string | null;
  commentId?: string | null;
  actorId?: string | null;
  /** minimal; titles etc. are re-read at render time */
  payload?: Record<string, unknown>;
  /** unique per logical notification; a second notify() with the same key is a no-op */
  dedupeKey: string;
}

/**
 * Create one notification for one recipient (N-01):
 * never the actor · only active, real users · the recipient must be able to view the task/doc
 * *now* (else dropped silently) · deduped · preferences decide the channels.
 * Returns true when a notification was stored.
 */
export async function notify(n: NotifyInput): Promise<boolean> {
  if (n.actorId && n.userId === n.actorId) return false;
  const [u] = await db.select().from(users).where(eq(users.id, n.userId));
  if (!u || !u.isActive || u.isSystem || u.isPlaceholder) return false;
  const access = await accessForUser(u.id);
  if (!access) return false;
  if (n.taskId && (await access.levelOf('task', n.taskId)) === 'none') return false;
  if (n.docId && !n.taskId && (await access.levelOf('doc', n.docId)) === 'none') return false;

  const { matrix } = await userPrefs(u.id);
  const prefs = matrix[n.eventType];
  const pref = (ch: string): ChannelPref => (prefs as Record<string, ChannelPref> | undefined)?.[ch] ?? { enabled: false, digest: 'instant' };
  const channels = notificationChannels().filter((c) => pref(c.key).enabled);
  if (!channels.length) return false;

  const [row] = await db.insert(notifications).values({
    userId: u.id,
    eventType: n.eventType,
    taskId: n.taskId ?? null,
    docId: n.docId ?? null,
    commentId: n.commentId ?? null,
    actorId: n.actorId ?? null,
    payload: n.payload ?? {},
    dedupeKey: n.dedupeKey,
    // in-app off but email on: keep the row (digests need it) but out of the inbox
    clearedAt: pref('in_app').enabled ? null : new Date(),
  }).onConflictDoNothing({ target: notifications.dedupeKey }).returning();
  if (!row) return false;

  const recipient = { id: u.id, email: u.email, displayName: u.displayName, timezone: u.timezone };
  for (const c of channels) {
    try {
      await c.deliver({ notification: row, recipient, access, pref: pref(c.key) });
    } catch (err) {
      log.error({ err, channel: c.key, notification: row.id }, 'notification delivery failed');
    }
  }
  return true;
}

async function notifyMany(userIds: Iterable<string>, base: Omit<NotifyInput, 'userId' | 'dedupeKey'>, key: (userId: string) => string) {
  const done: string[] = [];
  for (const userId of new Set(userIds)) {
    if (await notify({ ...base, userId, dedupeKey: key(userId) })) done.push(userId);
  }
  return done;
}

/**
 * Notify every active admin/owner (in-app + email per their `admin_alert` preference).
 * `dedupeKey` makes repeated calls idempotent (e.g. `secret-expiry:smtp:password:7d`).
 * Returns the number of admins notified.
 */
export async function notifyAdmins(input: { title: string; body?: string | null; link?: string | null; dedupeKey?: string }): Promise<number> {
  const admins = await db.select({ id: users.id }).from(users)
    .where(and(inArray(users.role, ['owner', 'admin']), eq(users.isActive, true), eq(users.isSystem, false)));
  const key = input.dedupeKey ?? `${Date.now()}:${Math.random().toString(36).slice(2)}`;
  const done = await notifyMany(admins.map((a) => a.id), {
    eventType: 'admin_alert',
    payload: { title: input.title, body: input.body ?? null, link: input.link ?? null },
  }, (uid) => `admin:${key}:${uid}`);
  return done.length;
}

// ───────────── fan-out from domain events ─────────────

async function assigneesOf(taskId: string) {
  return (await db.select({ u: taskAssignees.userId }).from(taskAssignees).where(eq(taskAssignees.taskId, taskId))).map((r) => r.u);
}

export function registerFanout() {
  on('task.assigned', async (e) => {
    const { taskId, actorId, userIds } = e.data;
    await notifyMany(userIds, { eventType: 'assigned', taskId, actorId }, (u) => `assigned:${taskId}:${u}:${e.id}`);
  });

  on('comment.created', async (e) => {
    const { commentId, taskId, docId, actorId, mentionedUserIds } = e.data;
    // one notification per recipient per comment: a mention wins over "commented"
    const key = (u: string) => `comment:${commentId}:${u}`;
    const base = { taskId, docId, commentId, actorId };
    await notifyMany(mentionedUserIds, { ...base, eventType: 'mentioned' }, key);
    const followers = new Set<string>();
    if (taskId) {
      for (const u of await assigneesOf(taskId)) followers.add(u);
      const [t] = await db.select({ c: tasks.createdBy }).from(tasks).where(eq(tasks.id, taskId));
      if (t?.c) followers.add(t.c);
    } else if (docId) {
      const [d] = await db.select({ c: docs.createdBy }).from(docs).where(eq(docs.id, docId));
      if (d?.c) followers.add(d.c);
    }
    for (const u of mentionedUserIds) followers.delete(u);
    await notifyMany(followers, { ...base, eventType: 'commented' }, key);
  });

  on('task.updated', async (e) => {
    const { taskId, actorId, changes } = e.data;
    if (!changes.statusId) return;
    const recipients = new Set(await assigneesOf(taskId));
    const [t] = await db.select({ c: tasks.createdBy }).from(tasks).where(eq(tasks.id, taskId));
    if (t?.c) recipients.add(t.c);
    await notifyMany(recipients, {
      eventType: 'status_changed', taskId, actorId,
      payload: { fromStatusId: changes.statusId.from, toStatusId: changes.statusId.to },
    }, (u) => `status:${taskId}:${u}:${e.id}`);
  });

  on('doc.mentioned', async (e) => {
    const { docId, actorId, mentionedUserIds } = e.data;
    await notifyMany(mentionedUserIds, { eventType: 'mentioned', docId, actorId }, (u) => `docmention:${docId}:${u}:${e.id}`);
  });
}

// ───────────── due-date scan ─────────────

const RANK = { none: 0, soon: 1, overdue: 2 } as const;
type DueState = keyof typeof RANK;

/** Where a task's due date stands for someone in `tz` at `now`. */
export function dueState(dueAt: Date, dueHasTime: boolean, tz: string, now = new Date()): DueState {
  if (dueHasTime) {
    if (dueAt <= now) return 'overdue';
    return dueAt.getTime() - now.getTime() <= 24 * 3_600_000 ? 'soon' : 'none';
  }
  // date-only: compare calendar days in the user's timezone ("soon" = due today or tomorrow)
  const today = startOfDay(now, tz);
  const dueDay = startOfDay(dueAt, tz);
  if (dueDay < today) return 'overdue';
  const dayAfterTomorrow = startOfDay(addDays(today, 2.5), tz);
  return dueDay < dayAfterTomorrow ? 'soon' : 'none';
}

/**
 * Job (every minute): due_soon / overdue for assignees of open tasks. Evaluated in each
 * assignee's timezone; each user gets each transition once (dedupe key includes due_at).
 * tasks.due_notified records the transition every assignee has reached, so tasks drop out of
 * the scan; the task service resets it when due_at changes.
 */
export async function scanDueDates(now = new Date()) {
  const wsTz = (await workspaceTimezone()) ?? DEFAULT_TZ;
  const candidates = await db.select().from(tasks).where(and(
    isNotNull(tasks.dueAt), isNull(tasks.completedAt), isNull(tasks.archivedAt), isNull(tasks.deletedAt),
    lt(tasks.dueAt, new Date(now.getTime() + 50 * 3_600_000)),
    or(isNull(tasks.dueNotified), ne(tasks.dueNotified, 'overdue')),
  ));
  if (!candidates.length) return 0;
  const assigneeRows = await db.select({ taskId: taskAssignees.taskId, userId: users.id, tz: users.timezone })
    .from(taskAssignees).innerJoin(users, eq(users.id, taskAssignees.userId))
    .where(and(inArray(taskAssignees.taskId, candidates.map((t) => t.id)), eq(users.isActive, true)));
  let sent = 0;
  for (const t of candidates) {
    const already: DueState = t.dueNotified === 'soon' ? 'soon' : 'none';
    const people = assigneeRows.filter((a) => a.taskId === t.id);
    let reachedByAll: DueState = people.length ? 'overdue' : dueState(t.dueAt!, t.dueHasTime, wsTz, now);
    for (const p of people) {
      const st = dueState(t.dueAt!, t.dueHasTime, p.tz ?? wsTz, now);
      if (RANK[st] < RANK[reachedByAll]) reachedByAll = st;
      if (st === 'none' || RANK[st] <= RANK[already]) continue;
      const eventType = st === 'overdue' ? 'overdue' : 'due_soon';
      const ok = await notify({
        userId: p.userId, eventType, taskId: t.id, payload: { dueAt: t.dueAt!.toISOString() },
        dedupeKey: `${eventType}:${t.id}:${p.userId}:${t.dueAt!.toISOString()}`,
      });
      if (ok) sent++;
    }
    if (RANK[reachedByAll] > RANK[already]) {
      // guard on due_at so a concurrent due-date change (which resets due_notified) isn't overwritten
      await db.update(tasks).set({ dueNotified: reachedByAll })
        .where(and(eq(tasks.id, t.id), eq(tasks.dueAt, t.dueAt!), sql`coalesce(${tasks.dueNotified}, '') <> 'overdue'`));
    }
  }
  return sent;
}

/** Inbox query helpers shared by routes and tests. */
export const visibleNow = (now = new Date()) =>
  and(isNull(notifications.clearedAt), or(isNull(notifications.snoozedUntil), lt(notifications.snoozedUntil, now)));
export const notSnoozed = (now = new Date()) => or(isNull(notifications.snoozedUntil), lt(notifications.snoozedUntil, now));
export const snoozedNow = (now = new Date()) => and(isNull(notifications.clearedAt), gt(notifications.snoozedUntil, now));
