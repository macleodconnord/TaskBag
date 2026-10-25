import { and, asc, eq, isNull } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { db } from '../../db/client';
import { folders, lists, listTaskLinks, spaces } from '../../db/schema';
import { NotFound } from '../../lib/errors';
import { emit } from '../../lib/events';
import { auth, parse, type Req } from '../../lib/http';
import { runTx } from '../../lib/tx';
import { findTask } from '../tasks/service';
import { linkedFromTask, linkedListForTask, linkTaskToList, rollupForList, unlinkTask, wouldCycle } from './service';

/** /api/list-links — List ↔ Task link (V-12). */
export default async function listLinksRoutes(app: FastifyInstance) {
  const loadTask = async (req: Req, ref: string, action: 'view' | 'edit') => {
    const { access } = auth(req);
    const task = await findTask(db, ref);
    if (!task) throw new NotFound('Task not found');
    await access.require(action, 'task', task.id);
    return task;
  };

  /** The task's linked list with a viewer-filtered rollup; `null` if not linked. */
  app.get<{ Params: { ref: string } }>('/task/:ref', async (req) => {
    const { access } = auth(req);
    const task = await loadTask(req, req.params.ref, 'view');
    return { linkedList: await linkedListForTask(db, task, access) };
  });

  /** Link a task to a list: edit on the task, view on the list. 1:1 both ways, cycle-checked. */
  app.put<{ Params: { ref: string } }>('/task/:ref', async (req) => {
    const { user, access } = auth(req);
    const { listId } = parse(z.object({ listId: z.string().uuid() }), req.body);
    const task = await loadTask(req, req.params.ref, 'edit');
    await access.require('view', 'list', listId);
    await runTx(async (tx) => {
      const [prev] = await tx.select().from(listTaskLinks).where(eq(listTaskLinks.taskId, task.id));
      await linkTaskToList(tx, task, listId, user.id);
      if (prev?.listId !== listId) emit('task.updated', { taskId: task.id, actorId: user.id, changes: { linkedListId: { from: prev?.listId ?? null, to: listId } } });
    });
    return { linkedList: await linkedListForTask(db, task, access) };
  });

  app.delete<{ Params: { ref: string } }>('/task/:ref', async (req) => {
    const { user } = auth(req);
    const task = await loadTask(req, req.params.ref, 'edit');
    await runTx(async (tx) => {
      const removed = await unlinkTask(tx, task.id);
      if (removed) emit('task.updated', { taskId: task.id, actorId: user.id, changes: { linkedListId: { from: removed.listId, to: null } } });
    });
    return { ok: true };
  });

  /** Rollup of a list (hidden when the viewer can't see it). */
  app.get<{ Params: { id: string } }>('/list/:id/rollup', async (req) => {
    const { access } = auth(req);
    return rollupForList(db, parse(z.string().uuid(), req.params.id), access);
  });

  /** The task that owns a list (breadcrumb), or null. */
  app.get<{ Params: { id: string } }>('/list/:id/owner', async (req) => {
    const { access } = auth(req);
    const id = parse(z.string().uuid(), req.params.id);
    await access.require('view', 'list', id);
    return { linkedFromTask: await linkedFromTask(db, id, access) };
  });

  /** Lists this task could be linked to (visible, not archived, free, no cycle). */
  app.get<{ Params: { ref: string } }>('/task/:ref/candidates', async (req) => {
    const { access } = auth(req);
    const task = await loadTask(req, req.params.ref, 'edit');
    const rows = await db.select({ id: lists.id, name: lists.name, aclScopeId: lists.aclScopeId, spaceName: spaces.name, folderName: folders.name, linkedTask: listTaskLinks.taskId })
      .from(lists).innerJoin(spaces, eq(spaces.id, lists.spaceId)).leftJoin(folders, eq(folders.id, lists.folderId))
      .leftJoin(listTaskLinks, eq(listTaskLinks.listId, lists.id))
      .where(and(isNull(lists.archivedAt), isNull(spaces.archivedAt))).orderBy(asc(spaces.position), asc(spaces.name), asc(lists.name));
    const out = [];
    for (const r of rows) {
      if (r.linkedTask && r.linkedTask !== task.id) continue;
      if ((await access.levelOfScope(r.aclScopeId)) === 'none') continue;
      if (await wouldCycle(db, task.listId, r.id)) continue;
      out.push({ id: r.id, name: r.name, spaceName: r.spaceName, folderName: r.folderName });
    }
    return out;
  });
}
