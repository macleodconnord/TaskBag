import { and, inArray, isNull } from 'drizzle-orm';
import { db } from '../../db/client';
import { comments, docs, notifications, statuses, tasks, users } from '../../db/schema';
import type { AccessContext } from '../../lib/access';
import { DEFAULT_TZ, formatInTz } from '../../lib/dates';

export type NotificationRow = typeof notifications.$inferSelect;

export interface RenderedNotification {
  id: string;
  eventType: string;
  createdAt: Date;
  readAt: Date | null;
  snoozedUntil: Date | null;
  /** access was revoked (or the object is gone): no title, no actor, no excerpt */
  redacted: boolean;
  actor: { id: string; displayName: string; avatarUrl: string | null } | null;
  task: { id: string; key: string; name: string; status: { name: string; color: string } | null; completed: boolean } | null;
  doc: { id: string; title: string } | null;
  /** e.g. "Alice assigned you" */
  headline: string;
  /** the task name / doc title / alert title */
  subject: string;
  /** excerpt (comment text, alert body, …) */
  body: string | null;
  /** app-relative link (/t/KEY, /docs/:id, or an admin link) */
  link: string | null;
}

const excerpt = (s: string, n = 220) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);

/**
 * Render notifications for one recipient at read time. Every task/doc is re-checked with the
 * recipient's access (permissions.md §6.4): if they can no longer see it, the item is redacted.
 */
export async function renderNotifications(rows: NotificationRow[], access: AccessContext, tz = DEFAULT_TZ): Promise<RenderedNotification[]> {
  if (!rows.length) return [];
  const taskIds = [...new Set(rows.map((r) => r.taskId).filter((x): x is string => !!x))];
  const docIds = [...new Set(rows.map((r) => r.docId).filter((x): x is string => !!x))];
  const actorIds = [...new Set(rows.map((r) => r.actorId).filter((x): x is string => !!x))];
  const commentIds = [...new Set(rows.map((r) => r.commentId).filter((x): x is string => !!x))];
  const statusIds = new Set<string>();
  for (const r of rows) if (typeof r.payload.toStatusId === 'string') statusIds.add(r.payload.toStatusId);

  const [taskRows, docRows, actorRows, commentRows] = await Promise.all([
    taskIds.length ? db.select().from(tasks).where(and(inArray(tasks.id, taskIds), isNull(tasks.deletedAt))) : [],
    docIds.length ? db.select({ id: docs.id, title: docs.title, aclScopeId: docs.aclScopeId }).from(docs).where(inArray(docs.id, docIds)) : [],
    actorIds.length ? db.select({ id: users.id, displayName: users.displayName, avatarUrl: users.avatarUrl }).from(users).where(inArray(users.id, actorIds)) : [],
    commentIds.length ? db.select({ id: comments.id, bodyText: comments.bodyText, deletedAt: comments.deletedAt }).from(comments).where(inArray(comments.id, commentIds)) : [],
  ]);
  for (const t of taskRows) statusIds.add(t.statusId);
  const statusRows = statusIds.size ? await db.select().from(statuses).where(inArray(statuses.id, [...statusIds])) : [];

  const taskMap = new Map(taskRows.map((t) => [t.id, t]));
  const docMap = new Map(docRows.map((d) => [d.id, d]));
  const actorMap = new Map(actorRows.map((a) => [a.id, a]));
  const commentMap = new Map(commentRows.map((c) => [c.id, c]));
  const statusMap = new Map(statusRows.map((s) => [s.id, s]));
  const visible = new Map<string, boolean>();
  const canSee = async (scopeId: string) => {
    if (!visible.has(scopeId)) visible.set(scopeId, (await access.levelOfScope(scopeId)) !== 'none');
    return visible.get(scopeId)!;
  };

  const out: RenderedNotification[] = [];
  for (const r of rows) {
    const base = { id: r.id, eventType: r.eventType, createdAt: r.createdAt, readAt: r.readAt, snoozedUntil: r.snoozedUntil };
    const t = r.taskId ? taskMap.get(r.taskId) : undefined;
    const d = r.docId ? docMap.get(r.docId) : undefined;
    const revoked = (r.taskId && (!t || !(await canSee(t.aclScopeId)))) || (!r.taskId && r.docId && (!d || !(await canSee(d.aclScopeId))));
    if (revoked) {
      out.push({
        ...base, redacted: true, actor: null, task: null, doc: null, body: null, link: null,
        headline: r.taskId ? 'A task you no longer have access to' : 'A doc you no longer have access to',
        subject: r.taskId ? 'A task you no longer have access to' : 'A doc you no longer have access to',
      });
      continue;
    }
    const actor = r.actorId ? actorMap.get(r.actorId) ?? null : null;
    const who = actor?.displayName ?? 'Someone';
    const st = t ? statusMap.get(t.statusId) : undefined;
    const task = t ? { id: t.id, key: t.key, name: t.name, status: st ? { name: st.name, color: st.color } : null, completed: !!t.completedAt } : null;
    const doc = d ? { id: d.id, title: d.title } : null;
    const c = r.commentId ? commentMap.get(r.commentId) : undefined;
    const commentText = c && !c.deletedAt ? excerpt(c.bodyText) : null;
    const where = task ? 'a task' : 'a doc';
    let headline: string;
    let body: string | null = null;
    switch (r.eventType) {
      case 'assigned': headline = `${who} assigned you`; break;
      case 'mentioned':
        headline = r.commentId ? `${who} mentioned you in a comment` : `${who} mentioned you in ${where}`;
        body = commentText;
        break;
      case 'commented': headline = `${who} commented`; body = commentText; break;
      case 'status_changed': {
        const to = typeof r.payload.toStatusId === 'string' ? statusMap.get(r.payload.toStatusId) : undefined;
        headline = `${who} changed the status${to ? ` to ${to.name}` : ''}`;
        break;
      }
      case 'due_soon':
      case 'overdue': {
        const due = t?.dueAt ? formatInTz(t.dueAt, tz, t.dueHasTime) : null;
        headline = r.eventType === 'overdue' ? `Overdue${due ? ` — was due ${due}` : ''}` : `Due soon${due ? ` — ${due}` : ''}`;
        break;
      }
      case 'admin_alert':
        headline = String(r.payload.title ?? 'Admin alert');
        body = typeof r.payload.body === 'string' ? r.payload.body : null;
        break;
      default: headline = r.eventType;
    }
    const subject = task ? `${task.key} ${task.name}` : doc ? doc.title : String(r.payload.title ?? 'Notification');
    const link = task ? `/t/${task.key}` : doc ? `/docs/${doc.id}` : typeof r.payload.link === 'string' ? r.payload.link : null;
    out.push({ ...base, redacted: false, actor, task, doc, headline, subject, body, link });
  }
  return out;
}
