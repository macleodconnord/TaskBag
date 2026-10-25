import type { RichText } from '@app/shared';
import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { Tx } from '../../db/client';
import {
  checklistItems, checklists, customFields, lists, statuses, tags, taskAssignees, taskFieldValues, tasks, taskTags, users,
} from '../../db/schema';
import type { AccessContext } from '../../lib/access';
import { NotFound, Validation } from '../../lib/errors';
import { createStatusSet, statusesForList } from '../hierarchy/service';
import { fieldsForList, sortFields, type FieldRow } from '../fields/service';
import { createTask, type TaskRow } from '../tasks/service';

/*
 * Template payloads (templates.payload jsonb). Dates are stored relative to the source task's
 * creation time (ms offsets) and re-anchored to "now" when applied.
 */
export interface TplChecklist {
  name: string;
  items: Array<{ ref: string; parentRef: string | null; name: string; assigneeId: string | null }>;
}
export interface TplFieldValue {
  fieldId: string;
  fieldName: string;
  fieldType: string;
  value: unknown;
  /** date fields: offset from creation instead of an absolute date */
  offsetMs?: number;
}
export interface TplTask {
  name: string;
  /** source task's creation time (epoch ms): offsets are relative to it */
  baseMs?: number;
  description: RichText | null;
  priority: number | null;
  status: { name: string; group: string } | null;
  startOffsetMs: number | null;
  dueOffsetMs: number | null;
  dueHasTime: boolean;
  timeEstimateMin: number | null;
  assigneeIds: string[];
  tags: Array<{ name: string; color: string }>;
  checklists: TplChecklist[];
  fieldValues: TplFieldValue[];
  subtasks: TplTask[];
}
export interface TaskTemplatePayload {
  version: 1;
  task: TplTask;
}
export interface ListTemplatePayload {
  version: 1;
  description: RichText | null;
  /** the list's own statuses, when it overrode its space's */
  statuses: Array<{ name: string; color: string; group: 'open' | 'active' | 'done' | 'closed' }> | null;
  /** fields defined on the list itself (recreated on the new list) */
  fields: Array<{ id: string; name: string; type: string; config: Record<string, unknown>; required: boolean }>;
  tasks: TplTask[];
}

const MAX_TASKS = 1000;

// ───────────── serialize ─────────────

/** Serialize a task tree. Subtasks the viewer can't see are left out. */
export async function serializeTask(tx: Tx, task: TaskRow, access: AccessContext, budget = { n: 0 }): Promise<TplTask> {
  if (++budget.n > MAX_TASKS) throw new Validation(`Templates are limited to ${MAX_TASKS} tasks`);
  const base = task.createdAt.getTime();
  const [assignees, tagRows, status, cls, fvs, subs] = await Promise.all([
    tx.select({ u: taskAssignees.userId }).from(taskAssignees).where(eq(taskAssignees.taskId, task.id)),
    tx.select({ name: tags.name, color: tags.color }).from(taskTags).innerJoin(tags, eq(tags.id, taskTags.tagId)).where(eq(taskTags.taskId, task.id)),
    tx.select({ name: statuses.name, group: statuses.group }).from(statuses).where(eq(statuses.id, task.statusId)).then((r) => r[0] ?? null),
    tx.select().from(checklists).where(eq(checklists.taskId, task.id)).orderBy(asc(checklists.position)),
    tx.select({ fieldId: taskFieldValues.fieldId, value: taskFieldValues.value, name: customFields.name, type: customFields.type })
      .from(taskFieldValues).innerJoin(customFields, eq(customFields.id, taskFieldValues.fieldId)).where(eq(taskFieldValues.taskId, task.id)),
    tx.select().from(tasks).where(and(eq(tasks.parentTaskId, task.id), isNull(tasks.deletedAt), await access.filter(tasks.aclScopeId))).orderBy(asc(tasks.position)),
  ]);
  const tplChecklists: TplChecklist[] = [];
  for (const cl of cls) {
    const items = await tx.select().from(checklistItems).where(eq(checklistItems.checklistId, cl.id)).orderBy(asc(checklistItems.position));
    tplChecklists.push({ name: cl.name, items: items.map((i) => ({ ref: i.id, parentRef: i.parentItemId, name: i.name, assigneeId: i.assigneeId })) });
  }
  const subtasks: TplTask[] = [];
  for (const s of subs) subtasks.push(await serializeTask(tx, s, access, budget));
  return {
    name: task.name,
    baseMs: base,
    description: (task.description as RichText | null) ?? null,
    priority: task.priority,
    status,
    startOffsetMs: task.startAt ? task.startAt.getTime() - base : null,
    dueOffsetMs: task.dueAt ? task.dueAt.getTime() - base : null,
    dueHasTime: task.dueHasTime,
    timeEstimateMin: task.timeEstimateMin,
    assigneeIds: assignees.map((a) => a.u),
    tags: tagRows,
    checklists: tplChecklists,
    fieldValues: fvs.filter((f) => f.type !== 'formula').map((f) => ({
      fieldId: f.fieldId, fieldName: f.name, fieldType: f.type, value: f.value,
      ...(f.type === 'date' && typeof f.value === 'string' ? { offsetMs: Date.parse(f.value) - base } : {}),
    })),
    subtasks,
  };
}

export async function serializeList(tx: Tx, listId: string, access: AccessContext): Promise<ListTemplatePayload> {
  const [list] = await tx.select().from(lists).where(eq(lists.id, listId));
  if (!list) throw new NotFound('List not found');
  const own = list.statusSetId ? await statusesForList(tx, listId) : null;
  const fieldRows = sortFields(await tx.select().from(customFields)
    .where(and(eq(customFields.scopeType, 'list'), eq(customFields.scopeId, listId), isNull(customFields.archivedAt))));
  const roots = await tx.select().from(tasks).where(and(
    eq(tasks.listId, listId), isNull(tasks.parentTaskId), isNull(tasks.deletedAt), isNull(tasks.archivedAt), await access.filter(tasks.aclScopeId),
  )).orderBy(asc(tasks.position));
  const budget = { n: 0 };
  const out: TplTask[] = [];
  for (const t of roots) out.push(await serializeTask(tx, t, access, budget));
  return {
    version: 1,
    description: (list.description as RichText | null) ?? null,
    statuses: own ? own.map((s) => ({ name: s.name, color: s.color, group: s.group })) : null,
    fields: fieldRows.map((f) => ({ id: f.id, name: f.name, type: f.type, config: f.config, required: f.required })),
    tasks: out,
  };
}

export const countTasks = (ts: TplTask[]): number => ts.reduce((n, t) => n + 1 + countTasks(t.subtasks), 0);

// ───────────── apply ─────────────

interface ApplyCtx {
  listId: string;
  spaceId: string;
  actorId: string;
  now: number;
  statuses: Array<{ id: string; name: string; group: string }>;
  fields: FieldRow[];
  /** template field id → new field id (list templates recreate list fields) */
  fieldMap: Map<string, string>;
  activeUsers: Set<string>;
  tagCache: Map<string, string>;
}

async function makeCtx(tx: Tx, listId: string, actorId: string, fieldMap = new Map<string, string>()): Promise<ApplyCtx> {
  const [l] = await tx.select({ spaceId: lists.spaceId }).from(lists).where(eq(lists.id, listId));
  if (!l) throw new NotFound('List not found');
  const active = await tx.select({ id: users.id }).from(users).where(eq(users.isActive, true));
  return {
    listId, spaceId: l.spaceId, actorId, now: Date.now(),
    statuses: await statusesForList(tx, listId),
    fields: await fieldsForList(tx, listId),
    fieldMap,
    activeUsers: new Set(active.map((u) => u.id)),
    tagCache: new Map(),
  };
}

async function tagId(tx: Tx, ctx: ApplyCtx, t: { name: string; color: string }) {
  const k = t.name.toLowerCase();
  if (ctx.tagCache.has(k)) return ctx.tagCache.get(k)!;
  let [row] = await tx.select({ id: tags.id }).from(tags).where(and(eq(tags.spaceId, ctx.spaceId), sql`lower(${tags.name}) = ${k}`));
  if (!row) [row] = await tx.insert(tags).values({ spaceId: ctx.spaceId, name: t.name, color: t.color }).returning({ id: tags.id });
  ctx.tagCache.set(k, row.id);
  return row.id;
}

/** Map a template field value onto a field of the target list; null when it doesn't fit. */
const DAY = 86_400_000;
/**
 * Re-anchor a relative date: same number of calendar days after "now" as the original was after the
 * source task's creation, keeping the original time of day (so date-only values stay on a day).
 */
export function shiftDate(baseMs: number | undefined, offsetMs: number, nowMs: number) {
  if (baseMs === undefined) return new Date(nowMs + offsetMs).toISOString();
  const orig = baseMs + offsetMs;
  const day = (ms: number) => Math.floor(ms / DAY) * DAY;
  const days = Math.round((day(orig) - day(baseMs)) / DAY);
  return new Date(day(nowMs) + days * DAY + (orig - day(orig))).toISOString();
}

async function mapFieldValue(tx: Tx, ctx: ApplyCtx, fv: TplFieldValue, baseMs: number | undefined): Promise<{ fieldId: string; value: unknown } | null> {
  const mapped = ctx.fieldMap.get(fv.fieldId) ?? fv.fieldId;
  const field = ctx.fields.find((f) => f.id === mapped)
    ?? ctx.fields.find((f) => f.name.toLowerCase() === fv.fieldName.toLowerCase() && f.type === fv.fieldType);
  if (!field || field.type !== fv.fieldType || field.type === 'formula') return null;
  let value = fv.value;
  if (field.type === 'date' && fv.offsetMs !== undefined) value = shiftDate(baseMs, fv.offsetMs, ctx.now);
  if (field.type === 'dropdown' || field.type === 'labels') {
    const ids = new Set(((field.config.options as Array<{ id: string }> | undefined) ?? []).map((o) => o.id));
    if (Array.isArray(value)) value = value.filter((v) => ids.has(String(v)));
    else if (!ids.has(String(value))) value = null;
  }
  if (field.type === 'user' && Array.isArray(value)) value = value.filter((v) => ctx.activeUsers.has(String(v)));
  if (field.type === 'relationship' && Array.isArray(value) && value.length) {
    const ok = await tx.select({ id: tasks.id }).from(tasks).where(and(inArray(tasks.id, value.map(String)), isNull(tasks.deletedAt)));
    const okIds = new Set(ok.map((r) => r.id));
    value = value.filter((v) => okIds.has(String(v)));
  }
  if (value === null || value === undefined || (Array.isArray(value) && !value.length)) return null;
  return { fieldId: field.id, value };
}

async function applyTask(tx: Tx, ctx: ApplyCtx, t: TplTask, opts: { parentTaskId: string | null; name?: string; statusId?: string }): Promise<TaskRow> {
  const status = opts.statusId ? ctx.statuses.find((s) => s.id === opts.statusId)
    : t.status ? (ctx.statuses.find((s) => s.name.toLowerCase() === t.status!.name.toLowerCase()) ?? ctx.statuses.find((s) => s.group === t.status!.group)) : undefined;
  const tagIds: string[] = [];
  for (const tg of t.tags) tagIds.push(await tagId(tx, ctx, tg));
  const task = await createTask(tx, {
    listId: ctx.listId,
    parentTaskId: opts.parentTaskId,
    name: opts.name ?? t.name,
    description: t.description,
    statusId: status?.id,
    priority: t.priority,
    startAt: t.startOffsetMs != null ? shiftDate(t.baseMs, t.startOffsetMs, ctx.now) : null,
    dueAt: t.dueOffsetMs != null ? shiftDate(t.baseMs, t.dueOffsetMs, ctx.now) : null,
    dueHasTime: t.dueHasTime,
    timeEstimateMin: t.timeEstimateMin,
    assigneeIds: t.assigneeIds.filter((u) => ctx.activeUsers.has(u)),
    tagIds,
  }, { actorId: ctx.actorId });

  for (const [i, cl] of t.checklists.entries()) {
    const [ncl] = await tx.insert(checklists).values({ taskId: task.id, name: cl.name, position: i }).returning();
    const refMap = new Map<string, string>();
    const ordered = [...cl.items.filter((x) => !x.parentRef), ...cl.items.filter((x) => x.parentRef)];
    for (const [j, it] of ordered.entries()) {
      const [n] = await tx.insert(checklistItems).values({
        checklistId: ncl.id, name: it.name, position: j,
        assigneeId: it.assigneeId && ctx.activeUsers.has(it.assigneeId) ? it.assigneeId : null,
        parentItemId: it.parentRef ? refMap.get(it.parentRef) ?? null : null,
      }).returning();
      refMap.set(it.ref, n.id);
    }
  }
  for (const fv of t.fieldValues) {
    const m = await mapFieldValue(tx, ctx, fv, t.baseMs);
    if (m) await tx.insert(taskFieldValues).values({ taskId: task.id, fieldId: m.fieldId, value: m.value, updatedBy: ctx.actorId }).onConflictDoNothing();
  }
  for (const s of t.subtasks) await applyTask(tx, ctx, s, { parentTaskId: task.id });
  return task;
}

/** Create a task (with its subtree) from a task template. Caller checked create_child / edit on parent. */
export async function applyTaskTemplate(tx: Tx, payload: TaskTemplatePayload, target: { listId: string; parentTaskId?: string | null; name?: string; statusId?: string }, actorId: string) {
  let listId = target.listId;
  if (target.parentTaskId) {
    const [p] = await tx.select({ listId: tasks.listId }).from(tasks).where(eq(tasks.id, target.parentTaskId));
    if (!p) throw new NotFound('Parent task not found');
    listId = p.listId;
  }
  const ctx = await makeCtx(tx, listId, actorId);
  return applyTask(tx, ctx, payload.task, { parentTaskId: target.parentTaskId ?? null, name: target.name, statusId: target.statusId });
}

/** Fill a freshly created list from a list template (statuses, list fields, tasks). */
export async function applyListTemplate(tx: Tx, list: typeof lists.$inferSelect, payload: ListTemplatePayload, actorId: string) {
  const set: Partial<typeof lists.$inferInsert> = {};
  if (payload.description && !list.description) set.description = payload.description;
  if (payload.statuses?.length && !list.statusSetId) set.statusSetId = await createStatusSet(tx, 'list', list.id, payload.statuses);
  if (Object.keys(set).length) await tx.update(lists).set(set).where(eq(lists.id, list.id));
  const fieldMap = new Map<string, string>();
  for (const [i, f] of payload.fields.entries()) {
    const [n] = await tx.insert(customFields).values({ name: f.name, type: f.type, config: f.config, scopeType: 'list', scopeId: list.id, required: f.required, position: i }).returning();
    fieldMap.set(f.id, n.id);
  }
  const ctx = await makeCtx(tx, list.id, actorId, fieldMap);
  for (const t of payload.tasks) await applyTask(tx, ctx, t, { parentTaskId: null });
}
