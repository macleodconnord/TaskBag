import {
  checklistItemSchema, checklistSchema, createTagSchema, createTaskSchema, dependencySchema, filterGroupSchema,
  linkSchema, sortSchema, updateTaskSchema,
} from '@app/shared';
import { and, asc, desc, eq, inArray, isNotNull, isNull, or, sql, type SQL } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { db } from '../../db/client';
import {
  attachments, checklistItems, checklists, spaces, tags, taskDependencies, taskLinks, tasks, users,
} from '../../db/schema';
import { DEFAULT_TZ } from '../../lib/dates';
import { Forbidden, NotFound, Validation } from '../../lib/errors';
import { auth, parse, type Req } from '../../lib/http';
import { runTx } from '../../lib/tx';
import { listPath, statusesForList } from '../hierarchy/service';
import { andAll, compileFilter, compileSort } from './filter';
import {
  createTask, deleteTask, duplicateTask, findTask, hydrateTasks, restoreTask, runDetailExtensions, updateTask,
} from './service';

const listQuery = z.object({
  listId: z.string().uuid().optional(),
  folderId: z.string().uuid().optional(),
  spaceId: z.string().uuid().optional(),
  parentTaskId: z.string().uuid().optional(),
  ids: z.string().optional(), // comma-separated
  filter: z.string().optional(), // JSON FilterGroup
  sort: z.string().optional(), // JSON [{field,dir}]
  includeClosed: z.enum(['true', 'false']).optional(),
  includeSubtasks: z.enum(['true', 'false']).optional(),
  archived: z.enum(['true', 'false']).optional(),
  deleted: z.enum(['true', 'false']).optional(),
  q: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(5000).default(2000),
});

const json = <T>(s: string | undefined, schema: z.ZodType<T>, what: string): T | undefined => {
  if (!s) return undefined;
  try {
    return parse(schema, JSON.parse(s));
  } catch (e) {
    if (e instanceof Validation) throw e;
    throw new Validation(`Invalid ${what} JSON`);
  }
};

/** Shared task query used by List/Board/Table/Calendar/Gantt, My Work and exports. */
export async function queryTasks(req: Req, q: z.infer<typeof listQuery>) {
  const { user, access } = auth(req);
  const filter = json(q.filter, filterGroupSchema, 'filter');
  const sort = json(q.sort, z.array(sortSchema), 'sort') ?? [];
  const ctx = { userId: user.id, tz: user.timezone ?? DEFAULT_TZ };

  const where: Array<SQL | undefined> = [
    await access.filter(tasks.aclScopeId),
    q.deleted === 'true' ? isNotNull(tasks.deletedAt) : isNull(tasks.deletedAt),
    q.archived === 'true' ? isNotNull(tasks.archivedAt) : isNull(tasks.archivedAt),
    compileFilter(filter, ctx),
  ];
  if (q.listId) where.push(eq(tasks.listId, q.listId));
  if (q.folderId) where.push(sql`${tasks.listId} in (select id from lists where folder_id = ${q.folderId} and archived_at is null)`);
  if (q.spaceId) where.push(sql`${tasks.listId} in (select id from lists where space_id = ${q.spaceId} and archived_at is null)`);
  if (q.parentTaskId) where.push(eq(tasks.parentTaskId, q.parentTaskId));
  else if (q.includeSubtasks !== 'true' && !q.ids) where.push(isNull(tasks.parentTaskId));
  if (q.ids) where.push(inArray(tasks.id, q.ids.split(',').filter((s) => /^[0-9a-f-]{36}$/i.test(s))));
  if (q.includeClosed !== 'true' && !q.parentTaskId && !q.ids) where.push(sql`(select s."group" from statuses s where s.id = ${tasks.statusId}) <> 'closed'`);
  if (q.q) where.push(or(sql`${tasks.name} ilike ${'%' + q.q + '%'}`, sql`${tasks.key} ilike ${q.q + '%'}`));

  const rows = await db.select().from(tasks).where(andAll(...where))
    .orderBy(...compileSort(sort), asc(tasks.position), asc(tasks.seq))
    .limit(q.limit);
  return hydrateTasks(db, rows, access);
}

async function loadVisibleTask(req: Req, ref: string, action: Parameters<ReturnType<typeof auth>['access']['require']>[0] = 'view') {
  const { access } = auth(req);
  const task = await findTask(db, ref);
  if (!task) throw new NotFound('Task not found');
  const level = await access.require(action, 'task', task.id);
  return { task, level };
}

export default async function taskRoutes(app: FastifyInstance) {
  app.get('/', async (req) => queryTasks(req, parse(listQuery, req.query)));

  // ── My Work: assigned to me, bucketed client-side by due date ──
  app.get('/my-work', async (req) => {
    const { user } = auth(req);
    return queryTasks(req, parse(listQuery, {
      filter: JSON.stringify({ op: 'and', conditions: [{ field: 'assignee', op: 'any_of', value: [user.id] }, { field: 'status_group', op: 'none_of', value: ['done', 'closed'] }] }),
      includeSubtasks: 'true',
      sort: JSON.stringify([{ field: 'due_at', dir: 'asc' }]),
    }));
  });

  app.get<{ Params: { ref: string } }>('/:ref', async (req) => {
    const { access } = auth(req);
    const { task, level } = await loadVisibleTask(req, req.params.ref);
    const [hydrated] = await hydrateTasks(db, [task], access);
    const visible = await access.filter(tasks.aclScopeId);
    const [subtasks, cls, deps, blocking, links, files, path, listStatuses, creator] = await Promise.all([
      db.select().from(tasks).where(and(eq(tasks.parentTaskId, task.id), isNull(tasks.deletedAt), visible)).orderBy(asc(tasks.position))
        .then((r) => hydrateTasks(db, r, access)),
      loadChecklists(task.id),
      db.select({ id: tasks.id, key: tasks.key, name: tasks.name, statusId: tasks.statusId, completedAt: tasks.completedAt })
        .from(taskDependencies).innerJoin(tasks, eq(tasks.id, taskDependencies.dependsOnTaskId))
        .where(and(eq(taskDependencies.taskId, task.id), isNull(tasks.deletedAt), visible)),
      db.select({ id: tasks.id, key: tasks.key, name: tasks.name, statusId: tasks.statusId, completedAt: tasks.completedAt })
        .from(taskDependencies).innerJoin(tasks, eq(tasks.id, taskDependencies.taskId))
        .where(and(eq(taskDependencies.dependsOnTaskId, task.id), isNull(tasks.deletedAt), visible)),
      db.select({ id: tasks.id, key: tasks.key, name: tasks.name, statusId: tasks.statusId, completedAt: tasks.completedAt })
        .from(taskLinks).innerJoin(tasks, or(
          and(eq(taskLinks.taskAId, task.id), eq(tasks.id, taskLinks.taskBId)),
          and(eq(taskLinks.taskBId, task.id), eq(tasks.id, taskLinks.taskAId)),
        ))
        .where(and(isNull(tasks.deletedAt), visible)),
      db.select().from(attachments).where(and(eq(attachments.taskId, task.id), isNull(attachments.deletedAt))).orderBy(desc(attachments.createdAt)),
      listPath(db, task.listId),
      statusesForList(db, task.listId),
      task.createdBy ? db.select({ id: users.id, displayName: users.displayName }).from(users).where(eq(users.id, task.createdBy)).then((r) => r[0] ?? null) : null,
    ]);
    let parent = null;
    if (task.parentTaskId && (await access.levelOf('task', task.parentTaskId)) !== 'none') {
      [parent] = await db.select({ id: tasks.id, key: tasks.key, name: tasks.name }).from(tasks).where(eq(tasks.id, task.parentTaskId));
    }
    return {
      ...hydrated,
      description: task.description,
      level,
      parent,
      creator,
      path,
      statuses: listStatuses,
      subtasks,
      checklists: cls,
      waitingOn: deps,
      blocking,
      linkedTasks: links,
      attachments: files,
      ...(await runDetailExtensions(db, task, access)),
    };
  });

  app.post('/', async (req) => {
    const { user, access } = auth(req);
    const input = parse(createTaskSchema, req.body);
    if (input.parentTaskId) await access.require('edit', 'task', input.parentTaskId);
    else await access.require('create_child', 'list', input.listId);
    const task = await runTx((tx) => createTask(tx, input, { actorId: user.id }));
    const [h] = await hydrateTasks(db, [task], access);
    return h;
  });

  app.patch<{ Params: { ref: string } }>('/:ref', async (req) => {
    const { user, access } = auth(req);
    const input = parse(updateTaskSchema, req.body);
    const { task } = await loadVisibleTask(req, req.params.ref, 'edit');
    if (input.listId && input.listId !== task.listId) await access.require('create_child', 'list', input.listId);
    if (input.parentTaskId) await access.require('edit', 'task', input.parentTaskId);
    if (input.archived !== undefined) await access.require('edit', 'task', task.id);
    const { task: updated } = await runTx((tx) => updateTask(tx, task, input, { actorId: user.id }));
    const [h] = await hydrateTasks(db, [updated], access);
    return h;
  });

  app.delete<{ Params: { ref: string } }>('/:ref', async (req) => {
    const { user } = auth(req);
    const { task } = await loadVisibleTask(req, req.params.ref, 'delete');
    await runTx((tx) => deleteTask(tx, task, user.id));
    return { ok: true };
  });

  app.post<{ Params: { ref: string } }>('/:ref/restore', async (req) => {
    const { access } = auth(req);
    const [task] = await db.select().from(tasks).where(eq(tasks.id, req.params.ref));
    if (!task) throw new NotFound();
    if ((await access.levelOfScope(task.aclScopeId)) !== 'full') throw new NotFound();
    await runTx((tx) => restoreTask(tx, task.id));
    return { ok: true };
  });

  app.post<{ Params: { ref: string } }>('/:ref/duplicate', async (req) => {
    const { user, access } = auth(req);
    const { task } = await loadVisibleTask(req, req.params.ref);
    if (task.parentTaskId) await access.require('edit', 'task', task.parentTaskId);
    else await access.require('create_child', 'list', task.listId);
    const copy = await runTx((tx) => duplicateTask(tx, task, user.id, { name: `${task.name} (copy)` }));
    const [h] = await hydrateTasks(db, [copy], access);
    return h;
  });

  // ── bulk edit (V-08): permission checked per task, partial failures reported ──
  app.post('/bulk', async (req) => {
    const { user, access } = auth(req);
    const body = parse(z.object({
      taskIds: z.array(z.string().uuid()).min(1).max(500),
      action: z.enum(['update', 'delete']),
      update: updateTaskSchema.extend({
        addAssigneeIds: z.array(z.string().uuid()).optional(),
        removeAssigneeIds: z.array(z.string().uuid()).optional(),
        addTagIds: z.array(z.string().uuid()).optional(),
      }).optional(),
    }), req.body);
    const results: Array<{ id: string; ok: boolean; error?: string }> = [];
    if (body.update?.listId) await access.require('create_child', 'list', body.update.listId);
    for (const id of body.taskIds) {
      try {
        const task = await findTask(db, id);
        if (!task) throw new NotFound('Task not found');
        if (body.action === 'delete') {
          await access.require('delete', 'task', id);
          await runTx((tx) => deleteTask(tx, task, user.id));
        } else {
          await access.require('edit', 'task', id);
          const { addAssigneeIds, removeAssigneeIds, addTagIds, ...rest } = body.update ?? {};
          const input = { ...rest };
          if (addAssigneeIds || removeAssigneeIds) {
            const cur = (await hydrateTasks(db, [task], access))[0].assignees as Array<{ id: string }>;
            const ids = new Set(cur.map((a) => a.id));
            addAssigneeIds?.forEach((a) => ids.add(a));
            removeAssigneeIds?.forEach((a) => ids.delete(a));
            input.assigneeIds = [...ids];
          }
          if (addTagIds) {
            const cur = (await hydrateTasks(db, [task], access))[0].tags as Array<{ id: string }>;
            input.tagIds = [...new Set([...cur.map((t) => t.id), ...addTagIds])];
          }
          // a status from another list's set is skipped rather than failing the whole batch
          if (input.statusId && !(await statusesForList(db, task.listId)).some((s) => s.id === input.statusId)) {
            throw new Validation('Status is not available in this task’s list');
          }
          await runTx((tx) => updateTask(tx, task, input, { actorId: user.id }));
        }
        results.push({ id, ok: true });
      } catch (err) {
        const msg = err instanceof NotFound ? 'Not found' : err instanceof Forbidden ? 'No permission' : err instanceof Error ? err.message : 'Failed';
        results.push({ id, ok: false, error: msg });
      }
    }
    return { results, succeeded: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok).length };
  });

  // ── checklists ──
  app.post<{ Params: { ref: string } }>('/:ref/checklists', async (req) => {
    const { task } = await loadVisibleTask(req, req.params.ref, 'edit');
    const { name } = parse(checklistSchema, req.body);
    const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(checklists).where(eq(checklists.taskId, task.id));
    const [cl] = await runTx((tx) => tx.insert(checklists).values({ taskId: task.id, name, position: n }).returning());
    await touch(task.id);
    return cl;
  });
  app.patch<{ Params: { id: string } }>('/checklists/:id', async (req) => {
    const cl = await checklistTask(req, req.params.id);
    const { name } = parse(checklistSchema.partial().extend({ position: z.number().optional() }), req.body);
    await db.update(checklists).set({ ...(name ? { name } : {}) }).where(eq(checklists.id, cl.id));
    await touch(cl.taskId);
    return { ok: true };
  });
  app.delete<{ Params: { id: string } }>('/checklists/:id', async (req) => {
    const cl = await checklistTask(req, req.params.id);
    await db.delete(checklists).where(eq(checklists.id, cl.id));
    await touch(cl.taskId);
    return { ok: true };
  });
  app.post<{ Params: { id: string } }>('/checklists/:id/items', async (req) => {
    const cl = await checklistTask(req, req.params.id);
    const input = parse(checklistItemSchema.extend({ name: z.string().trim().min(1).max(500) }), req.body);
    const [{ n }] = await db.select({ n: sql<number>`coalesce(max(position), -1)::int + 1` }).from(checklistItems).where(eq(checklistItems.checklistId, cl.id));
    const [item] = await db.insert(checklistItems).values({
      checklistId: cl.id, name: input.name, assigneeId: input.assigneeId ?? null,
      parentItemId: input.parentItemId ?? null, resolved: input.resolved ?? false, position: input.position ?? n,
    }).returning();
    await touch(cl.taskId);
    return item;
  });
  app.patch<{ Params: { id: string } }>('/checklist-items/:id', async (req) => {
    const [item] = await db.select().from(checklistItems).where(eq(checklistItems.id, req.params.id));
    if (!item) throw new NotFound();
    const cl = await checklistTask(req, item.checklistId);
    const input = parse(checklistItemSchema, req.body);
    await db.update(checklistItems).set(input).where(eq(checklistItems.id, item.id));
    await touch(cl.taskId);
    return { ok: true };
  });
  app.delete<{ Params: { id: string } }>('/checklist-items/:id', async (req) => {
    const [item] = await db.select().from(checklistItems).where(eq(checklistItems.id, req.params.id));
    if (!item) throw new NotFound();
    const cl = await checklistTask(req, item.checklistId);
    await db.delete(checklistItems).where(or(eq(checklistItems.id, item.id), eq(checklistItems.parentItemId, item.id)));
    await touch(cl.taskId);
    return { ok: true };
  });

  // ── dependencies (waiting on / blocking) ──
  app.post<{ Params: { ref: string } }>('/:ref/dependencies', async (req) => {
    const { access } = auth(req);
    const { task } = await loadVisibleTask(req, req.params.ref, 'edit');
    const { dependsOnTaskId } = parse(dependencySchema, req.body);
    await access.require('view', 'task', dependsOnTaskId);
    if (dependsOnTaskId === task.id) throw new Validation('A task cannot depend on itself');
    const cycle = await db.execute(sql`
      with recursive chain as (
        select depends_on_task_id as id from task_dependencies where task_id = ${dependsOnTaskId}
        union select d.depends_on_task_id from task_dependencies d join chain c on d.task_id = c.id
      ) select 1 from chain where id = ${task.id} limit 1`);
    if (cycle.length) throw new Validation('That would create a circular dependency');
    await db.insert(taskDependencies).values({ taskId: task.id, dependsOnTaskId }).onConflictDoNothing();
    await touch(task.id);
    return { ok: true };
  });
  app.delete<{ Params: { ref: string; other: string } }>('/:ref/dependencies/:other', async (req) => {
    const { task } = await loadVisibleTask(req, req.params.ref, 'edit');
    await db.delete(taskDependencies).where(or(
      and(eq(taskDependencies.taskId, task.id), eq(taskDependencies.dependsOnTaskId, req.params.other)),
      and(eq(taskDependencies.taskId, req.params.other), eq(taskDependencies.dependsOnTaskId, task.id)),
    ));
    await touch(task.id);
    return { ok: true };
  });

  // ── linked tasks ──
  app.post<{ Params: { ref: string } }>('/:ref/links', async (req) => {
    const { access, user } = auth(req);
    const { task } = await loadVisibleTask(req, req.params.ref, 'edit');
    const { otherTaskId } = parse(linkSchema, req.body);
    if (otherTaskId === task.id) throw new Validation('Cannot link a task to itself');
    await access.require('view', 'task', otherTaskId);
    const [a, b] = [task.id, otherTaskId].sort();
    await db.insert(taskLinks).values({ taskAId: a, taskBId: b, createdBy: user.id }).onConflictDoNothing();
    await touch(task.id);
    return { ok: true };
  });
  app.delete<{ Params: { ref: string; other: string } }>('/:ref/links/:other', async (req) => {
    const { task } = await loadVisibleTask(req, req.params.ref, 'edit');
    const [a, b] = [task.id, req.params.other].sort();
    await db.delete(taskLinks).where(and(eq(taskLinks.taskAId, a), eq(taskLinks.taskBId, b)));
    await touch(task.id);
    return { ok: true };
  });

  // ── tags (per space) ──
  app.get('/tags/all', async (req) => {
    const { access } = auth(req);
    const { spaceId } = parse(z.object({ spaceId: z.string().uuid().optional() }), req.query);
    const visibleSpaces = db.select({ id: spaces.id }).from(spaces).where(await access.filter(spaces.aclScopeId));
    return db.select().from(tags)
      .where(and(spaceId ? eq(tags.spaceId, spaceId) : undefined, inArray(tags.spaceId, visibleSpaces)))
      .orderBy(asc(tags.name));
  });
  app.post('/tags', async (req) => {
    const { access } = auth(req);
    const input = parse(createTagSchema, req.body);
    await access.require('edit', 'space', input.spaceId);
    const [tag] = await db.insert(tags).values({ spaceId: input.spaceId, name: input.name, color: input.color ?? '#64748b' })
      .onConflictDoUpdate({ target: [tags.spaceId, sql`lower(${tags.name})`] as never, set: { name: input.name } }).returning();
    return tag;
  });
  app.patch<{ Params: { id: string } }>('/tags/:id', async (req) => {
    const { access } = auth(req);
    const [tag] = await db.select().from(tags).where(eq(tags.id, req.params.id));
    if (!tag) throw new NotFound();
    await access.require('manage', 'space', tag.spaceId);
    const input = parse(z.object({ name: z.string().trim().min(1).max(50).optional(), color: z.string().max(20).optional() }), req.body);
    const [t] = await db.update(tags).set(input).where(eq(tags.id, tag.id)).returning();
    return t;
  });
  app.delete<{ Params: { id: string } }>('/tags/:id', async (req) => {
    const { access } = auth(req);
    const [tag] = await db.select().from(tags).where(eq(tags.id, req.params.id));
    if (!tag) throw new NotFound();
    await access.require('manage', 'space', tag.spaceId);
    await db.delete(tags).where(eq(tags.id, tag.id));
    return { ok: true };
  });
}

async function loadChecklists(taskId: string) {
  const cls = await db.select().from(checklists).where(eq(checklists.taskId, taskId)).orderBy(asc(checklists.position));
  if (!cls.length) return [];
  const items = await db.select().from(checklistItems).where(inArray(checklistItems.checklistId, cls.map((c) => c.id))).orderBy(asc(checklistItems.position));
  return cls.map((c) => ({ ...c, items: items.filter((i) => i.checklistId === c.id) }));
}

async function checklistTask(req: Req, checklistId: string) {
  const { access } = auth(req);
  const [cl] = await db.select().from(checklists).where(eq(checklists.id, checklistId));
  if (!cl) throw new NotFound();
  await access.require('edit', 'task', cl.taskId);
  return cl;
}

/** Bump updated_at so pollers see the change. */
export async function touch(taskId: string) {
  await db.update(tasks).set({ updatedAt: new Date() }).where(eq(tasks.id, taskId));
}
