import { positionBetween, richTextToPlain, type CreateTaskInput, type Level, type UpdateTaskInput } from '@app/shared';
import { and, asc, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { Tx } from '../../db/client';
import {
  checklistItems, checklists, spaces, statuses, tags, taskAssignees, taskFieldValues, tasks, taskTags, users, lists,
} from '../../db/schema';
import type { AccessContext } from '../../lib/access';
import { afterMove, dropScopesFor } from '../../lib/acl';
import { shortId } from '../../lib/crypto';
import { NotFound, Validation } from '../../lib/errors';
import { emit } from '../../lib/events';
import { statusesForList, statusSetIdForList } from '../hierarchy/service';

export type TaskRow = typeof tasks.$inferSelect;

// ───────────── extension points (custom fields, list links, gitea, …) ─────────────

type DetailExt = (tx: Tx, task: TaskRow, access: AccessContext) => Promise<unknown>;
type ListExt = (tx: Tx, tasks: TaskRow[], access: AccessContext) => Promise<Map<string, unknown>>;
const detailExts = new Map<string, DetailExt>();
const listExts = new Map<string, ListExt>();

/** Add a key to GET /tasks/:id (e.g. `fields`, `linkedList`, `development`). */
export const registerTaskDetailExtension = (key: string, fn: DetailExt) => detailExts.set(key, fn);
/** Add a key to every task in list responses (e.g. `fields` values, `linkedList` progress). */
export const registerTaskListExtension = (key: string, fn: ListExt) => listExts.set(key, fn);

// ───────────── reads ─────────────

export async function hydrateTasks(tx: Tx, rows: TaskRow[], access: AccessContext) {
  if (!rows.length) return [];
  const ids = rows.map((r) => r.id);
  const [assigneeRows, tagRows, statusRows, subRows, checkRows] = await Promise.all([
    tx.select({ taskId: taskAssignees.taskId, id: users.id, displayName: users.displayName, avatarUrl: users.avatarUrl })
      .from(taskAssignees).innerJoin(users, eq(users.id, taskAssignees.userId)).where(inArray(taskAssignees.taskId, ids)),
    tx.select({ taskId: taskTags.taskId, id: tags.id, name: tags.name, color: tags.color })
      .from(taskTags).innerJoin(tags, eq(tags.id, taskTags.tagId)).where(inArray(taskTags.taskId, ids)),
    tx.select().from(statuses).where(inArray(statuses.id, [...new Set(rows.map((r) => r.statusId))])),
    tx.select({
      parentId: tasks.parentTaskId,
      total: sql<number>`count(*)::int`,
      done: sql<number>`count(${tasks.completedAt})::int`,
    }).from(tasks)
      .where(and(inArray(tasks.parentTaskId, ids), isNull(tasks.deletedAt), isNull(tasks.archivedAt), await access.filter(tasks.aclScopeId)))
      .groupBy(tasks.parentTaskId),
    tx.select({
      taskId: checklists.taskId,
      total: sql<number>`count(${checklistItems.id})::int`,
      done: sql<number>`count(*) filter (where ${checklistItems.resolved})::int`,
    }).from(checklists).innerJoin(checklistItems, eq(checklistItems.checklistId, checklists.id))
      .where(inArray(checklists.taskId, ids)).groupBy(checklists.taskId),
  ]);
  const by = <T extends { taskId: string }>(list: T[]) => {
    const m = new Map<string, Omit<T, 'taskId'>[]>();
    for (const { taskId, ...rest } of list) m.set(taskId, [...(m.get(taskId) ?? []), rest]);
    return m;
  };
  const assignees = by(assigneeRows);
  const tagMap = by(tagRows);
  const statusMap = new Map(statusRows.map((s) => [s.id, s]));
  const subMap = new Map(subRows.map((s) => [s.parentId!, s]));
  const checkMap = new Map(checkRows.map((c) => [c.taskId, c]));
  const extResults = await Promise.all([...listExts].map(async ([k, fn]) => [k, await fn(tx, rows, access)] as const));
  const levels = new Map<string, Level>();
  for (const r of rows) if (!levels.has(r.aclScopeId)) levels.set(r.aclScopeId, await access.levelOfScope(r.aclScopeId));

  return rows.map((r) => {
    const { descriptionText: _dt, ...base } = r;
    const out: Record<string, unknown> = {
      ...base,
      description: undefined,
      status: statusMap.get(r.statusId) ?? null,
      assignees: assignees.get(r.id) ?? [],
      tags: tagMap.get(r.id) ?? [],
      subtaskCount: subMap.get(r.id)?.total ?? 0,
      subtaskDoneCount: subMap.get(r.id)?.done ?? 0,
      checklistTotal: checkMap.get(r.id)?.total ?? 0,
      checklistDone: checkMap.get(r.id)?.done ?? 0,
      _perms: { level: levels.get(r.aclScopeId) ?? 'none' },
    };
    delete out.search;
    for (const [k, m] of extResults) {
      const v = m.get(r.id);
      if (v !== undefined) out[k] = v;
    }
    return out;
  });
}

export async function runDetailExtensions(tx: Tx, task: TaskRow, access: AccessContext) {
  const out: Record<string, unknown> = {};
  for (const [k, fn] of detailExts) out[k] = await fn(tx, task, access);
  return out;
}

/** Look up a task by uuid, key (OPS-12) or short id; returns null when missing or deleted. */
export async function findTask(tx: Tx, ref: string): Promise<TaskRow | null> {
  const cond = /^[0-9a-f-]{36}$/i.test(ref) ? eq(tasks.id, ref) : /^[a-z0-9]{8}$/.test(ref) ? eq(tasks.shortId, ref) : eq(tasks.key, ref.toUpperCase());
  const [t] = await tx.select().from(tasks).where(and(cond, isNull(tasks.deletedAt)));
  return t ?? null;
}

// ───────────── writes ─────────────

async function nextPosition(tx: Tx, listId: string, parentTaskId: string | null) {
  const [last] = await tx.select({ p: tasks.position }).from(tasks)
    .where(and(eq(tasks.listId, listId), parentTaskId ? eq(tasks.parentTaskId, parentTaskId) : isNull(tasks.parentTaskId)))
    .orderBy(desc(tasks.position)).limit(1);
  return positionBetween(last?.p ?? null, null);
}

async function isClosedStatus(tx: Tx, statusId: string) {
  const [s] = await tx.select({ g: statuses.group }).from(statuses).where(eq(statuses.id, statusId));
  return s?.g === 'done' || s?.g === 'closed';
}

export interface CreateTaskOptions {
  actorId: string | null;
  source?: 'app' | 'clickup' | 'ninjaone';
  /** importer: keep original timestamps */
  createdAt?: Date;
  silent?: boolean;
}

/** Create a task. The caller has already checked `create_child` on the list or parent task. */
export async function createTask(tx: Tx, input: CreateTaskInput, opts: CreateTaskOptions): Promise<TaskRow> {
  let listId = input.listId;
  let aclScopeId: string;
  if (input.parentTaskId) {
    const [parent] = await tx.select().from(tasks).where(and(eq(tasks.id, input.parentTaskId), isNull(tasks.deletedAt)));
    if (!parent) throw new NotFound('Parent task not found');
    listId = parent.listId;
    aclScopeId = parent.aclScopeId;
  } else {
    const [l] = await tx.select({ s: lists.aclScopeId }).from(lists).where(eq(lists.id, listId));
    if (!l) throw new NotFound('List not found');
    aclScopeId = l.s;
  }
  const listStatuses = await statusesForList(tx, listId);
  let statusId = input.statusId;
  if (statusId && !listStatuses.some((s) => s.id === statusId)) throw new Validation('Status does not belong to this list');
  statusId ??= (listStatuses.find((s) => s.group === 'open') ?? listStatuses[0]).id;

  const [space] = await tx.update(spaces).set({ taskSeq: sql`${spaces.taskSeq} + 1` })
    .where(eq(spaces.id, sql`(select space_id from lists where id = ${listId})`))
    .returning({ seq: spaces.taskSeq, prefix: spaces.keyPrefix, workspaceId: spaces.workspaceId });

  const closed = await isClosedStatus(tx, statusId);
  const [task] = await tx.insert(tasks).values({
    workspaceId: space.workspaceId,
    listId,
    parentTaskId: input.parentTaskId ?? null,
    key: `${space.prefix}-${space.seq}`,
    shortId: shortId(),
    seq: space.seq,
    name: input.name,
    description: input.description ?? null,
    descriptionText: input.description ? richTextToPlain(input.description) : '',
    statusId,
    priority: input.priority ?? null,
    startAt: input.startAt ? new Date(input.startAt) : null,
    dueAt: input.dueAt ? new Date(input.dueAt) : null,
    dueHasTime: input.dueHasTime ?? false,
    timeEstimateMin: input.timeEstimateMin ?? null,
    position: input.position ?? (await nextPosition(tx, listId, input.parentTaskId ?? null)),
    aclScopeId,
    createdBy: opts.actorId,
    completedAt: closed ? new Date() : null,
    source: opts.source ?? 'app',
    ...(opts.createdAt ? { createdAt: opts.createdAt } : {}),
  }).returning();

  if (input.assigneeIds?.length) {
    await tx.insert(taskAssignees).values([...new Set(input.assigneeIds)].map((userId) => ({ taskId: task.id, userId })));
  }
  if (input.tagIds?.length) {
    await tx.insert(taskTags).values([...new Set(input.tagIds)].map((tagId) => ({ taskId: task.id, tagId })));
  }
  if (!opts.silent) {
    emit('task.created', { taskId: task.id, actorId: opts.actorId });
    if (input.assigneeIds?.length) emit('task.assigned', { taskId: task.id, actorId: opts.actorId, userIds: input.assigneeIds });
  }
  return task;
}

/**
 * Update a task. Permission checks (edit on task; for moves, create_child on the destination)
 * happen in the route. Returns the updated row and a field-level diff.
 */
export async function updateTask(tx: Tx, task: TaskRow, input: UpdateTaskInput, opts: { actorId: string | null; silent?: boolean }) {
  const set: Partial<typeof tasks.$inferInsert> = {};
  const changes: Record<string, { from: unknown; to: unknown }> = {};
  const track = (k: string, from: unknown, to: unknown) => {
    if (JSON.stringify(from) !== JSON.stringify(to)) changes[k] = { from, to };
  };

  if (input.name !== undefined) { set.name = input.name; track('name', task.name, input.name); }
  if (input.description !== undefined) {
    set.description = input.description;
    set.descriptionText = input.description ? richTextToPlain(input.description) : '';
    if (set.descriptionText !== task.descriptionText) changes.description = { from: null, to: null };
  }
  if (input.priority !== undefined) { set.priority = input.priority; track('priority', task.priority, input.priority); }
  if (input.startAt !== undefined) { set.startAt = input.startAt ? new Date(input.startAt) : null; track('startAt', task.startAt?.toISOString() ?? null, set.startAt?.toISOString() ?? null); }
  if (input.dueAt !== undefined) {
    set.dueAt = input.dueAt ? new Date(input.dueAt) : null;
    track('dueAt', task.dueAt?.toISOString() ?? null, set.dueAt?.toISOString() ?? null);
    if (changes.dueAt) set.dueNotified = null;
  }
  if (input.dueHasTime !== undefined) set.dueHasTime = input.dueHasTime;
  if (input.timeEstimateMin !== undefined) { set.timeEstimateMin = input.timeEstimateMin; track('timeEstimateMin', task.timeEstimateMin, input.timeEstimateMin); }
  if (input.position !== undefined) set.position = input.position;
  if (input.archived !== undefined) {
    set.archivedAt = input.archived ? (task.archivedAt ?? new Date()) : null;
    track('archived', !!task.archivedAt, input.archived);
  }

  // move to another list (root tasks only; subtasks follow their parent)
  let movedFromScope: string | null = null;
  if (input.listId && input.listId !== task.listId) {
    if (task.parentTaskId && input.parentTaskId === undefined) throw new Validation('Move the parent task, or detach the subtask first');
    movedFromScope = task.aclScopeId;
    set.listId = input.listId;
    track('listId', task.listId, input.listId);
  }
  if (input.parentTaskId !== undefined && input.parentTaskId !== task.parentTaskId) {
    if (input.parentTaskId) {
      if (input.parentTaskId === task.id) throw new Validation('A task cannot be its own parent');
      const cyc = await tx.execute(sql`
        with recursive up as (select id, parent_task_id from tasks where id = ${input.parentTaskId}
          union all select t.id, t.parent_task_id from tasks t join up on t.id = up.parent_task_id)
        select 1 from up where id = ${task.id} limit 1`);
      if (cyc.length) throw new Validation('That would create a cycle of subtasks');
      const [p] = await tx.select().from(tasks).where(eq(tasks.id, input.parentTaskId));
      if (!p) throw new NotFound('Parent task not found');
      set.listId = p.listId;
    }
    movedFromScope ??= task.aclScopeId;
    set.parentTaskId = input.parentTaskId;
    track('parentTaskId', task.parentTaskId, input.parentTaskId);
  }

  const targetList = set.listId ?? task.listId;
  if (input.statusId !== undefined || set.listId) {
    const listStatuses = await statusesForList(tx, targetList);
    let statusId = input.statusId ?? task.statusId;
    if (!listStatuses.some((s) => s.id === statusId)) {
      if (input.statusId) throw new Validation('Status does not belong to this list');
      // moving between status sets: keep the name if possible, else the first status of the same group
      const [old] = await tx.select().from(statuses).where(eq(statuses.id, task.statusId));
      statusId = (listStatuses.find((s) => s.name.toLowerCase() === old?.name.toLowerCase())
        ?? listStatuses.find((s) => s.group === old?.group) ?? listStatuses[0]).id;
    }
    if (statusId !== task.statusId) {
      set.statusId = statusId;
      track('statusId', task.statusId, statusId);
      const closed = await isClosedStatus(tx, statusId);
      set.completedAt = closed ? (task.completedAt ?? new Date()) : null;
    }
  }

  let addedAssignees: string[] = [];
  if (input.assigneeIds) {
    const current = (await tx.select({ u: taskAssignees.userId }).from(taskAssignees).where(eq(taskAssignees.taskId, task.id))).map((r) => r.u);
    const want = [...new Set(input.assigneeIds)];
    addedAssignees = want.filter((u) => !current.includes(u));
    const removed = current.filter((u) => !want.includes(u));
    if (removed.length) await tx.delete(taskAssignees).where(and(eq(taskAssignees.taskId, task.id), inArray(taskAssignees.userId, removed)));
    if (addedAssignees.length) await tx.insert(taskAssignees).values(addedAssignees.map((userId) => ({ taskId: task.id, userId })));
    if (addedAssignees.length || removed.length) changes.assignees = { from: current, to: want };
  }
  if (input.tagIds) {
    await tx.delete(taskTags).where(eq(taskTags.taskId, task.id));
    if (input.tagIds.length) await tx.insert(taskTags).values([...new Set(input.tagIds)].map((tagId) => ({ taskId: task.id, tagId })));
    changes.tags = { from: null, to: input.tagIds };
  }

  let updated = task;
  if (Object.keys(set).length) {
    [updated] = await tx.update(tasks).set(set).where(eq(tasks.id, task.id)).returning();
  } else if (Object.keys(changes).length) {
    [updated] = await tx.update(tasks).set({ updatedAt: new Date() }).where(eq(tasks.id, task.id)).returning();
  }

  if (set.listId && set.listId !== task.listId) {
    // subtasks always live in their root's list
    await tx.execute(sql`
      with recursive sub as (select id from tasks where parent_task_id = ${task.id}
        union all select t.id from tasks t join sub on t.parent_task_id = sub.id)
      update tasks set list_id = ${set.listId} where id in (select id from sub)`);
    // field values for fields that don't apply in the new location are kept (hidden), like ClickUp
  }
  if (movedFromScope) {
    await afterMove(tx, 'task', task.id, movedFromScope);
    [updated] = await tx.select().from(tasks).where(eq(tasks.id, task.id));
  }

  if (!opts.silent && Object.keys(changes).length) {
    emit('task.updated', { taskId: task.id, actorId: opts.actorId, changes });
    if (addedAssignees.length) emit('task.assigned', { taskId: task.id, actorId: opts.actorId, userIds: addedAssignees });
  }
  return { task: updated, changes };
}

/** Soft delete (trash). Subtasks go with it. */
export async function deleteTask(tx: Tx, task: TaskRow, actorId: string | null) {
  await tx.execute(sql`
    with recursive sub as (select id from tasks where id = ${task.id}
      union all select t.id from tasks t join sub on t.parent_task_id = sub.id)
    update tasks set deleted_at = now() where id in (select id from sub) and deleted_at is null`);
  emit('task.deleted', { taskId: task.id, actorId, listId: task.listId, name: task.name });
}

export async function restoreTask(tx: Tx, taskId: string) {
  await tx.execute(sql`
    with recursive sub as (select id from tasks where id = ${taskId}
      union all select t.id from tasks t join sub on t.parent_task_id = sub.id)
    update tasks set deleted_at = null where id in (select id from sub)`);
}

/** Hard-delete tasks trashed more than 30 days ago. */
export async function purgeTrash(tx: Tx) {
  const rows = await tx.select({ id: tasks.id }).from(tasks).where(sql`${tasks.deletedAt} < now() - interval '30 days'`);
  if (!rows.length) return 0;
  const ids = rows.map((r) => r.id);
  await dropScopesFor(tx, ids);
  await tx.delete(tasks).where(inArray(tasks.id, ids));
  return ids.length;
}

/** Duplicate a task with its subtasks, checklists, assignees, tags and field values. */
export async function duplicateTask(tx: Tx, task: TaskRow, actorId: string, opts: { name?: string; parentTaskId?: string | null; listId?: string } = {}): Promise<TaskRow> {
  const [assigneeRows, tagRows] = await Promise.all([
    tx.select({ u: taskAssignees.userId }).from(taskAssignees).where(eq(taskAssignees.taskId, task.id)),
    tx.select({ t: taskTags.tagId }).from(taskTags).where(eq(taskTags.taskId, task.id)),
  ]);
  const copy = await createTask(tx, {
    listId: opts.listId ?? task.listId,
    parentTaskId: opts.parentTaskId === undefined ? task.parentTaskId : opts.parentTaskId,
    name: opts.name ?? task.name,
    description: (task.description as CreateTaskInput['description']) ?? null,
    statusId: opts.listId && opts.listId !== task.listId ? undefined : task.statusId,
    priority: task.priority,
    startAt: task.startAt?.toISOString() ?? null,
    dueAt: task.dueAt?.toISOString() ?? null,
    dueHasTime: task.dueHasTime,
    timeEstimateMin: task.timeEstimateMin,
    assigneeIds: assigneeRows.map((r) => r.u),
    tagIds: opts.listId && opts.listId !== task.listId ? [] : tagRows.map((r) => r.t),
  }, { actorId });

  const fv = await tx.select().from(taskFieldValues).where(eq(taskFieldValues.taskId, task.id));
  if (fv.length) await tx.insert(taskFieldValues).values(fv.map((v) => ({ taskId: copy.id, fieldId: v.fieldId, value: v.value, updatedBy: actorId })));

  for (const cl of await tx.select().from(checklists).where(eq(checklists.taskId, task.id)).orderBy(asc(checklists.position))) {
    const [ncl] = await tx.insert(checklists).values({ taskId: copy.id, name: cl.name, position: cl.position }).returning();
    const items = await tx.select().from(checklistItems).where(eq(checklistItems.checklistId, cl.id)).orderBy(asc(checklistItems.position));
    const idMap = new Map<string, string>();
    for (const it of items.sort((a, b) => (a.parentItemId ? 1 : 0) - (b.parentItemId ? 1 : 0))) {
      const [n] = await tx.insert(checklistItems).values({
        checklistId: ncl.id, name: it.name, resolved: false, position: it.position, assigneeId: it.assigneeId,
        parentItemId: it.parentItemId ? idMap.get(it.parentItemId) ?? null : null,
      }).returning();
      idMap.set(it.id, n.id);
    }
  }
  const subs = await tx.select().from(tasks).where(and(eq(tasks.parentTaskId, task.id), isNull(tasks.deletedAt))).orderBy(asc(tasks.position));
  for (const s of subs) await duplicateTask(tx, s, actorId, { parentTaskId: copy.id, listId: opts.listId });
  return copy;
}

export { statusSetIdForList };
