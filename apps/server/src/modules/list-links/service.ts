import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { Tx } from '../../db/client';
import { lists, listTaskLinks, statuses, tasks } from '../../db/schema';
import type { AccessContext } from '../../lib/access';
import { Conflict, Validation } from '../../lib/errors';
import type { TaskRow } from '../tasks/service';

/**
 * List ↔ Task link (V-12): a task "owns" a list (1:1 both ways) and shows its rollup.
 * Rollups count only tasks the viewer can see (permissions.md §4); a list the viewer can't see
 * is returned as `{ hidden: true }` with no name and no counts (matrix rows 16–17).
 */

export type Rollup =
  | { hidden: true }
  | { hidden: false; listId: string; name: string; total: number; done: number; estimateMin: number };

/** Rollups for several lists, filtered by the viewer. Counts root tasks (not archived/deleted). */
export async function rollupsForLists(tx: Tx, listIds: string[], access: AccessContext): Promise<Map<string, Rollup>> {
  const out = new Map<string, Rollup>();
  if (!listIds.length) return out;
  const ls = await tx.select({ id: lists.id, name: lists.name, aclScopeId: lists.aclScopeId }).from(lists).where(inArray(lists.id, [...new Set(listIds)]));
  const visible: typeof ls = [];
  for (const l of ls) {
    if ((await access.levelOfScope(l.aclScopeId)) === 'none') out.set(l.id, { hidden: true });
    else visible.push(l);
  }
  if (visible.length) {
    const counts = await tx.select({
      listId: tasks.listId,
      total: sql<number>`count(*)::int`,
      done: sql<number>`count(${tasks.completedAt})::int`,
      est: sql<number>`coalesce(sum(${tasks.timeEstimateMin}), 0)::int`,
    }).from(tasks).where(and(
      inArray(tasks.listId, visible.map((l) => l.id)),
      isNull(tasks.parentTaskId), isNull(tasks.deletedAt), isNull(tasks.archivedAt),
      await access.filter(tasks.aclScopeId),
    )).groupBy(tasks.listId);
    const byList = new Map(counts.map((c) => [c.listId, c]));
    for (const l of visible) {
      const c = byList.get(l.id);
      out.set(l.id, { hidden: false, listId: l.id, name: l.name, total: c?.total ?? 0, done: c?.done ?? 0, estimateMin: c?.est ?? 0 });
    }
  }
  return out;
}

export async function rollupForList(tx: Tx, listId: string, access: AccessContext): Promise<Rollup> {
  return (await rollupsForLists(tx, [listId], access)).get(listId) ?? { hidden: true };
}

/** The linked list of one task with rollup + a short preview of its (visible) tasks; null if not linked. */
export async function linkedListForTask(tx: Tx, task: Pick<TaskRow, 'id'>, access: AccessContext) {
  const [link] = await tx.select().from(listTaskLinks).where(eq(listTaskLinks.taskId, task.id));
  if (!link) return null;
  const rollup = await rollupForList(tx, link.listId, access);
  if (rollup.hidden) return { hidden: true as const };
  const preview = await tx.select({
    id: tasks.id, key: tasks.key, name: tasks.name, completedAt: tasks.completedAt, dueAt: tasks.dueAt,
    status: { id: statuses.id, name: statuses.name, color: statuses.color, group: statuses.group },
  }).from(tasks).leftJoin(statuses, eq(statuses.id, tasks.statusId))
    .where(and(eq(tasks.listId, link.listId), isNull(tasks.parentTaskId), isNull(tasks.deletedAt), isNull(tasks.archivedAt), await access.filter(tasks.aclScopeId)))
    .orderBy(asc(tasks.position), asc(tasks.seq)).limit(8);
  const level = await access.levelOf('list', link.listId, tx);
  return { ...rollup, level, preview, linkedAt: link.createdAt };
}

/** Progress for task chips: taskId → rollup (only for linked tasks). */
export async function linkProgressForTasks(tx: Tx, rows: TaskRow[], access: AccessContext) {
  const out = new Map<string, Rollup>();
  if (!rows.length) return out;
  const links = await tx.select().from(listTaskLinks).where(inArray(listTaskLinks.taskId, rows.map((r) => r.id)));
  if (!links.length) return out;
  const rollups = await rollupsForLists(tx, links.map((l) => l.listId), access);
  for (const l of links) out.set(l.taskId, rollups.get(l.listId) ?? { hidden: true });
  return out;
}

/** The task owning a list (for the list's breadcrumb), if the viewer can see it. */
export async function linkedFromTask(tx: Tx, listId: string, access: AccessContext) {
  const [row] = await tx.select({ id: tasks.id, key: tasks.key, name: tasks.name, listId: tasks.listId, aclScopeId: tasks.aclScopeId, completedAt: tasks.completedAt })
    .from(listTaskLinks).innerJoin(tasks, eq(tasks.id, listTaskLinks.taskId))
    .where(and(eq(listTaskLinks.listId, listId), isNull(tasks.deletedAt)));
  if (!row || (await access.levelOfScope(row.aclScopeId)) === 'none') return null;
  const [l] = await tx.select({ name: lists.name }).from(lists).where(eq(lists.id, row.listId));
  return { id: row.id, key: row.key, name: row.name, completedAt: row.completedAt, listId: row.listId, listName: l?.name ?? null };
}

/**
 * Lists that may not be linked to a task in `taskListId`: the task's own list and every list that
 * would create a cycle (any list from which `taskListId` is reachable through links).
 */
export async function wouldCycle(tx: Tx, taskListId: string, targetListId: string) {
  if (taskListId === targetListId) return true;
  // lists reachable downward from the target: target → lists linked from tasks in it → …
  const rows = await tx.execute<{ list_id: string }>(sql`
    with recursive d(list_id) as (
      select ${targetListId}::uuid
      union
      select l.list_id from list_task_links l
        join tasks t on t.id = l.task_id
        join d on t.list_id = d.list_id
    ) select list_id from d where list_id = ${taskListId}::uuid limit 1`);
  return rows.length > 0;
}

/** Link (or re-link) a task to a list. Caller checked edit on the task and view on the list. */
export async function linkTaskToList(tx: Tx, task: TaskRow, listId: string, actorId: string) {
  const [list] = await tx.select({ id: lists.id }).from(lists).where(eq(lists.id, listId));
  if (!list) throw new Validation('List not found');
  if (await wouldCycle(tx, task.listId, listId)) {
    throw new Validation(task.listId === listId ? 'A task cannot be linked to its own list' : 'That would create a cycle of linked lists');
  }
  const [taken] = await tx.select().from(listTaskLinks).where(eq(listTaskLinks.listId, listId));
  if (taken && taken.taskId !== task.id) throw new Conflict('That list is already linked to another task');
  if (taken) return taken;
  await tx.delete(listTaskLinks).where(eq(listTaskLinks.taskId, task.id));
  const [row] = await tx.insert(listTaskLinks).values({ taskId: task.id, listId, createdBy: actorId }).returning();
  return row;
}

export async function unlinkTask(tx: Tx, taskId: string) {
  const rows = await tx.delete(listTaskLinks).where(eq(listTaskLinks.taskId, taskId)).returning();
  return rows[0] ?? null;
}
