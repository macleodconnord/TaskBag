import { desc, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { db } from '../../db/client';
import { templates, users } from '../../db/schema';
import type { AccessContext } from '../../lib/access';
import { Forbidden, NotFound, Validation } from '../../lib/errors';
import { auth, parse } from '../../lib/http';
import { runTx } from '../../lib/tx';
import { findTask, hydrateTasks } from '../tasks/service';
import {
  applyTaskTemplate, countTasks, serializeList, serializeTask, type ListTemplatePayload, type TaskTemplatePayload,
} from './service';

const meta = z.object({ name: z.string().trim().min(1).max(200), description: z.string().trim().max(2000).nullable().optional() });

function requireMember(access: AccessContext) {
  if (access.isGuest) throw new Forbidden('Guests cannot use templates');
}

const summary = (t: typeof templates.$inferSelect & { createdByName?: string | null }) => {
  const p = t.payload as unknown as Partial<TaskTemplatePayload & ListTemplatePayload>;
  const taskCount = t.kind === 'task' ? (p.task ? countTasks([p.task]) : 0) : countTasks(p.tasks ?? []);
  return {
    id: t.id, kind: t.kind, name: t.name, description: t.description, createdBy: t.createdBy,
    createdByName: t.createdByName ?? null, createdAt: t.createdAt, taskCount,
    fieldCount: t.kind === 'list' ? (p.fields?.length ?? 0) : (p.task?.fieldValues.length ?? 0),
  };
};

/** /api/templates — task templates (V-09) and list templates (V-10). Any non-guest can see and use them. */
export default async function templatesRoutes(app: FastifyInstance) {
  async function load(id: string) {
    const [t] = await db.select().from(templates).where(eq(templates.id, id));
    if (!t) throw new NotFound('Template not found');
    return t;
  }

  app.get('/', async (req) => {
    const { access } = auth(req);
    requireMember(access);
    const { kind } = parse(z.object({ kind: z.enum(['task', 'list']).optional() }), req.query);
    const rows = await db.select({ t: templates, createdByName: users.displayName }).from(templates)
      .leftJoin(users, eq(users.id, templates.createdBy))
      .where(kind ? eq(templates.kind, kind) : undefined).orderBy(desc(templates.createdAt));
    return rows.map((r) => summary({ ...r.t, createdByName: r.createdByName }));
  });

  app.get<{ Params: { id: string } }>('/:id', async (req) => {
    const { access } = auth(req);
    requireMember(access);
    const t = await load(parse(z.string().uuid(), req.params.id));
    return { ...summary(t), payload: t.payload };
  });

  /** Save a task (with visible subtasks, checklists, field values, relative dates) as a template. */
  app.post('/task', async (req) => {
    const { user, access } = auth(req);
    requireMember(access);
    const input = parse(meta.extend({ taskId: z.string().min(1) }), req.body);
    const task = await findTask(db, input.taskId);
    if (!task) throw new NotFound('Task not found');
    await access.require('view', 'task', task.id);
    const payload: TaskTemplatePayload = { version: 1, task: await serializeTask(db, task, access) };
    const [t] = await db.insert(templates).values({ kind: 'task', name: input.name, description: input.description ?? null, payload: payload as unknown as Record<string, unknown>, createdBy: user.id }).returning();
    return summary(t);
  });

  /** Save a list (statuses, list fields, visible tasks) as a template. */
  app.post('/list', async (req) => {
    const { user, access } = auth(req);
    requireMember(access);
    const input = parse(meta.extend({ listId: z.string().uuid() }), req.body);
    await access.require('view', 'list', input.listId);
    const payload = await serializeList(db, input.listId, access);
    const [t] = await db.insert(templates).values({ kind: 'list', name: input.name, description: input.description ?? null, payload: payload as unknown as Record<string, unknown>, createdBy: user.id }).returning();
    return summary(t);
  });

  app.patch<{ Params: { id: string } }>('/:id', async (req) => {
    const { user, access } = auth(req);
    requireMember(access);
    const t = await load(parse(z.string().uuid(), req.params.id));
    if (t.createdBy !== user.id && !access.isAdmin) throw new Forbidden('Only the creator or an admin can change this template');
    const input = parse(meta.partial(), req.body);
    const [u] = await db.update(templates).set({
      ...(input.name ? { name: input.name } : {}),
      ...(input.description !== undefined ? { description: input.description } : {}),
    }).where(eq(templates.id, t.id)).returning();
    return summary(u);
  });

  app.delete<{ Params: { id: string } }>('/:id', async (req) => {
    const { user, access } = auth(req);
    requireMember(access);
    const t = await load(parse(z.string().uuid(), req.params.id));
    if (t.createdBy !== user.id && !access.isAdmin) throw new Forbidden('Only the creator or an admin can delete this template');
    await db.delete(templates).where(eq(templates.id, t.id));
    return { ok: true };
  });

  /** Create a task from a task template: create_child on the list (or edit on the parent task). */
  app.post<{ Params: { id: string } }>('/:id/apply', async (req) => {
    const { user, access } = auth(req);
    requireMember(access);
    const t = await load(parse(z.string().uuid(), req.params.id));
    if (t.kind !== 'task') throw new Validation('That is not a task template');
    const input = parse(z.object({
      listId: z.string().uuid(),
      parentTaskId: z.string().uuid().nullable().optional(),
      name: z.string().trim().min(1).max(500).optional(),
      statusId: z.string().uuid().optional(),
    }), req.body);
    if (input.parentTaskId) await access.require('edit', 'task', input.parentTaskId);
    else await access.require('create_child', 'list', input.listId);
    const task = await runTx((tx) => applyTaskTemplate(tx, t.payload as unknown as TaskTemplatePayload, input, user.id));
    const [h] = await hydrateTasks(db, [task], access);
    return h;
  });
}
