import { VIEW_TYPES, viewConfigSchema } from '@app/shared';
import { and, asc, eq, inArray, isNull, ne, or, sql, type SQL } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { db, type Tx } from '../../db/client';
import { taskDependencies, tasks, views } from '../../db/schema';
import type { AccessContext } from '../../lib/access';
import { Forbidden, NotFound } from '../../lib/errors';
import { auth, parse } from '../../lib/http';
import { runTx } from '../../lib/tx';

/**
 * Saved views (V-02). A view lives at a scope (space/folder/list, or "everything") and is either
 * personal (only its owner sees it; any viewer of the scope may create one) or shared (everyone who
 * can see the scope sees it; creating/changing needs `edit` on the scope, admins for "everything").
 * One default per scope for shared views, and one per user for their personal views; the client
 * prefers the personal default.
 */
const SCOPE_TYPES = ['space', 'folder', 'list', 'everything'] as const;
type ScopeType = (typeof SCOPE_TYPES)[number];
type ViewRow = typeof views.$inferSelect;

const scopeQuery = z.object({
  scopeType: z.enum(SCOPE_TYPES),
  scopeId: z.string().uuid().optional(),
});

const createViewSchema = z.object({
  scopeType: z.enum(SCOPE_TYPES),
  scopeId: z.string().uuid().nullable().optional(),
  type: z.enum(VIEW_TYPES),
  name: z.string().trim().min(1).max(100),
  visibility: z.enum(['personal', 'shared']).default('personal'),
  config: viewConfigSchema.optional(),
  isDefault: z.boolean().optional(),
});

const updateViewSchema = z.object({
  name: z.string().trim().min(1).max(100).optional(),
  type: z.enum(VIEW_TYPES).optional(),
  visibility: z.enum(['personal', 'shared']).optional(),
  config: viewConfigSchema.optional(),
  isDefault: z.boolean().optional(),
  position: z.number().int().min(0).max(100_000).optional(),
});

function normScope(scopeType: ScopeType, scopeId: string | null | undefined): string | null {
  if (scopeType === 'everything') return null;
  if (!scopeId) throw new NotFound('Scope not found');
  return scopeId;
}

/** 404 unless the user can see the scope. */
async function requireScopeView(access: AccessContext, scopeType: ScopeType, scopeId: string | null) {
  if (scopeType === 'everything') return;
  await access.require('view', scopeType, scopeId!);
}

/** Whether the user may create/change shared views at this scope. */
async function canShareAt(access: AccessContext, scopeType: ScopeType, scopeId: string | null): Promise<boolean> {
  if (scopeType === 'everything') return access.isAdmin;
  const level = await access.levelOf(scopeType, scopeId!);
  return level === 'edit' || level === 'full';
}

async function requireShareAt(access: AccessContext, scopeType: ScopeType, scopeId: string | null) {
  if (!(await canShareAt(access, scopeType, scopeId))) {
    throw new Forbidden(scopeType === 'everything' ? 'Only admins can share views on Everything' : 'You need edit access here to share a view');
  }
}

/** Load a view the user can see (personal → owner only, shared → scope viewers). */
async function loadView(access: AccessContext, userId: string, id: string): Promise<ViewRow> {
  const [v] = await db.select().from(views).where(eq(views.id, id));
  if (!v) throw new NotFound('View not found');
  if (v.visibility === 'personal' && v.ownerId !== userId) throw new NotFound('View not found');
  await requireScopeView(access, v.scopeType, v.scopeId);
  return v;
}

/** May the user change (rename/configure/delete) this view? */
async function canModify(access: AccessContext, userId: string, v: ViewRow): Promise<boolean> {
  if (v.visibility === 'personal') return v.ownerId === userId;
  return canShareAt(access, v.scopeType, v.scopeId);
}

const scopeWhere = (scopeType: ScopeType, scopeId: string | null): SQL =>
  scopeId ? and(eq(views.scopeType, scopeType), eq(views.scopeId, scopeId))! : and(eq(views.scopeType, scopeType), isNull(views.scopeId))!;

/** Clear the other defaults in the same bucket (shared defaults, or this owner's personal defaults). */
async function clearDefaults(tx: Tx, v: Pick<ViewRow, 'id' | 'scopeType' | 'scopeId' | 'visibility' | 'ownerId'>) {
  await tx.update(views).set({ isDefault: false }).where(and(
    scopeWhere(v.scopeType, v.scopeId),
    ne(views.id, v.id),
    eq(views.visibility, v.visibility),
    v.visibility === 'personal' ? eq(views.ownerId, v.ownerId) : undefined,
  ));
}

const out = (v: ViewRow, canEdit: boolean) => ({ ...v, config: viewConfigSchema.parse(v.config ?? {}), canEdit });

export default async function viewsRoutes(app: FastifyInstance) {
  // ── list views at a scope ──
  app.get('/', async (req) => {
    const { user, access } = auth(req);
    const q = parse(scopeQuery, req.query);
    const scopeId = normScope(q.scopeType, q.scopeId);
    await requireScopeView(access, q.scopeType, scopeId);
    const rows = await db.select().from(views)
      .where(and(scopeWhere(q.scopeType, scopeId), or(eq(views.visibility, 'shared'), eq(views.ownerId, user.id))))
      .orderBy(asc(views.position), asc(views.createdAt));
    const canShare = await canShareAt(access, q.scopeType, scopeId);
    return {
      views: rows.map((v) => {
        try {
          return out(v, v.visibility === 'personal' ? v.ownerId === user.id : canShare);
        } catch {
          // a config written by an older/newer version: fall back to defaults instead of failing the page
          return { ...v, config: viewConfigSchema.parse({}), canEdit: v.visibility === 'personal' ? v.ownerId === user.id : canShare };
        }
      }),
      canShare,
    };
  });

  app.get<{ Params: { id: string } }>('/:id', async (req) => {
    const { user, access } = auth(req);
    const v = await loadView(access, user.id, req.params.id);
    return out(v, await canModify(access, user.id, v));
  });

  app.post('/', async (req) => {
    const { user, access } = auth(req);
    const input = parse(createViewSchema, req.body);
    const scopeId = normScope(input.scopeType, input.scopeId);
    await requireScopeView(access, input.scopeType, scopeId);
    if (input.visibility === 'shared') await requireShareAt(access, input.scopeType, scopeId);
    const created = await runTx(async (tx) => {
      const [{ n }] = await tx.select({ n: sql<number>`coalesce(max(${views.position}), -1)::int + 1` }).from(views).where(scopeWhere(input.scopeType, scopeId));
      const [v] = await tx.insert(views).values({
        scopeType: input.scopeType, scopeId, type: input.type, name: input.name, visibility: input.visibility,
        ownerId: user.id, config: input.config ?? viewConfigSchema.parse({}), position: n, isDefault: !!input.isDefault,
      }).returning();
      if (v.isDefault) await clearDefaults(tx, v);
      return v;
    });
    return out(created, true);
  });

  app.patch<{ Params: { id: string } }>('/:id', async (req) => {
    const { user, access } = auth(req);
    const v = await loadView(access, user.id, req.params.id);
    const input = parse(updateViewSchema, req.body);
    if (!(await canModify(access, user.id, v))) throw new Forbidden('You can’t change this view');
    if (input.visibility && input.visibility !== v.visibility) {
      // personal → shared needs share rights; shared → personal only by its owner (and share rights, checked above)
      if (input.visibility === 'shared') await requireShareAt(access, v.scopeType, v.scopeId);
      else if (v.ownerId !== user.id) throw new Forbidden('Only the view’s creator can make it personal');
    }
    const updated = await runTx(async (tx) => {
      const [u] = await tx.update(views).set({
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.type !== undefined ? { type: input.type } : {}),
        ...(input.visibility !== undefined ? { visibility: input.visibility } : {}),
        ...(input.config !== undefined ? { config: input.config } : {}),
        ...(input.isDefault !== undefined ? { isDefault: input.isDefault } : {}),
        ...(input.position !== undefined ? { position: input.position } : {}),
        updatedAt: new Date(),
      }).where(eq(views.id, v.id)).returning();
      if (u.isDefault && (input.isDefault || input.visibility)) await clearDefaults(tx, u);
      return u;
    });
    return out(updated, await canModify(access, user.id, updated));
  });

  app.delete<{ Params: { id: string } }>('/:id', async (req) => {
    const { user, access } = auth(req);
    const v = await loadView(access, user.id, req.params.id);
    if (!(await canModify(access, user.id, v))) throw new Forbidden('You can’t delete this view');
    await db.delete(views).where(eq(views.id, v.id));
    return { ok: true };
  });

  // ── dependency pairs among visible tasks (Gantt arrows) ──
  app.post('/dependencies', async (req) => {
    const { access } = auth(req);
    const { taskIds } = parse(z.object({ taskIds: z.array(z.string().uuid()).max(5000) }), req.body);
    if (!taskIds.length) return [];
    const visible = await access.filter(tasks.aclScopeId);
    // both ends must be in the requested set and visible to the caller
    const allowed = db.select({ id: tasks.id }).from(tasks).where(and(inArray(tasks.id, taskIds), isNull(tasks.deletedAt), visible));
    return db.select({ taskId: taskDependencies.taskId, dependsOnTaskId: taskDependencies.dependsOnTaskId })
      .from(taskDependencies)
      .where(and(inArray(taskDependencies.taskId, allowed), inArray(taskDependencies.dependsOnTaskId, allowed)));
  });
}
