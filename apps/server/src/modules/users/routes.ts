import { groupSchema, updateMeSchema, updateUserSchema, WORKSPACE_ROLES } from '@app/shared';
import { and, asc, eq, inArray, ne, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { db } from '../../db/client';
import { groupMembers, groups, sessions, taskAssignees, tasks, users } from '../../db/schema';
import { bumpAcl } from '../../lib/access';
import { Conflict, Forbidden, NotFound, Validation } from '../../lib/errors';
import { auth, parse } from '../../lib/http';
import { runTx, afterCommit } from '../../lib/tx';

const publicUser = {
  id: users.id, email: users.email, displayName: users.displayName, avatarUrl: users.avatarUrl, role: users.role,
  isActive: users.isActive, isSystem: users.isSystem, isPlaceholder: users.isPlaceholder, entraLinked: sql<boolean>`${users.entraOid} is not null`,
  lastLoginAt: users.lastLoginAt, isBreakglass: users.isBreakglass,
};

export default async function userRoutes(app: FastifyInstance) {
  /**
   * People directory for pickers. Guests only see people on tasks they can see
   * (permissions.md §1: no workspace-wide directory for guests).
   */
  app.get('/', async (req) => {
    const { user, access } = auth(req);
    const { all } = parse(z.object({ all: z.enum(['true', 'false']).optional() }), req.query);
    if (access.isGuest) {
      const visible = db.select({ id: tasks.id }).from(tasks).where(await access.filter(tasks.aclScopeId));
      const ids = (await db.selectDistinct({ u: taskAssignees.userId }).from(taskAssignees).where(inArray(taskAssignees.taskId, visible))).map((r) => r.u);
      return db.select(publicUser).from(users).where(and(inArray(users.id, [...new Set([...ids, user.id])]), eq(users.isActive, true)));
    }
    const showAll = all === 'true' && access.isAdmin;
    return db.select(publicUser).from(users)
      .where(showAll ? undefined : and(eq(users.isActive, true), eq(users.isSystem, false)))
      .orderBy(asc(users.displayName));
  });

  app.patch('/me', async (req) => {
    const { user } = auth(req);
    const input = parse(updateMeSchema, req.body);
    if (input.timezone) {
      try {
        new Intl.DateTimeFormat('en-US', { timeZone: input.timezone });
      } catch {
        throw new Validation('Unknown timezone');
      }
    }
    const [u] = await db.update(users).set(input).where(eq(users.id, user.id)).returning(publicUser);
    return u;
  });

  /** Admin: pre-create a user so they can be assigned before their first SSO login (matched by email). */
  app.post('/', async (req) => {
    const { access } = auth(req);
    access.requireAdmin();
    const input = parse(z.object({
      email: z.string().email(),
      displayName: z.string().trim().min(1).max(100),
      role: z.enum(['admin', 'member', 'guest']).default('member'),
    }), req.body);
    const [exists] = await db.select({ id: users.id }).from(users).where(sql`lower(${users.email}) = ${input.email.toLowerCase()}`);
    if (exists) throw new Conflict('A user with that email already exists');
    if (input.role === 'admin' && auth(req).user.role !== 'owner') throw new Forbidden('Only the owner can create admins');
    const [u] = await db.insert(users).values({ ...input, isPlaceholder: true }).returning(publicUser);
    bumpAcl();
    return u;
  });

  app.patch<{ Params: { id: string } }>('/:id', async (req) => {
    const { user: me, access } = auth(req);
    access.requireAdmin();
    const input = parse(updateUserSchema, req.body);
    const [target] = await db.select().from(users).where(eq(users.id, req.params.id));
    if (!target) throw new NotFound();
    const touchesAdmin = target.role === 'owner' || target.role === 'admin' || input.role === 'owner' || input.role === 'admin';
    if (input.role && input.role !== target.role && touchesAdmin && me.role !== 'owner') throw new Forbidden('Only the owner can change admins');
    if (target.id === me.id && (input.role || input.isActive === false)) throw new Validation('You cannot change your own role or deactivate yourself');
    if (input.role === 'owner' || (target.role === 'owner' && input.role)) {
      // ownership transfer: exactly one owner
      if (input.role === 'owner') {
        await runTx(async (tx) => {
          await tx.update(users).set({ role: 'admin' }).where(eq(users.role, 'owner'));
          await tx.update(users).set({ role: 'owner' }).where(eq(users.id, target.id));
        });
        bumpAcl();
        return { ok: true };
      }
      throw new Validation('Transfer ownership to someone else first');
    }
    await runTx(async (tx) => {
      await tx.update(users).set(input).where(eq(users.id, target.id));
      if (input.isActive === false) await tx.delete(sessions).where(eq(sessions.userId, target.id));
      if (input.role || input.isActive !== undefined) afterCommit(bumpAcl);
    });
    return { ok: true };
  });

  // ── groups ──
  app.get('/groups', async (req) => {
    const { access } = auth(req);
    if (access.isGuest) return [];
    const gs = await db.select().from(groups).orderBy(asc(groups.name));
    const members = await db.select({ groupId: groupMembers.groupId, userId: groupMembers.userId, source: groupMembers.source }).from(groupMembers);
    const allActive = await db.select({ id: users.id }).from(users).where(and(eq(users.isActive, true), eq(users.isSystem, false), ne(users.role, 'guest')));
    return gs.map((g) => ({
      ...g,
      members: g.isSystem && g.name === 'All Members' ? allActive.map((u) => ({ userId: u.id, source: 'local' })) : members.filter((m) => m.groupId === g.id),
    }));
  });

  app.post('/groups', async (req) => {
    const { access } = auth(req);
    access.requireAdmin();
    const input = parse(groupSchema, req.body);
    const g = await runTx(async (tx) => {
      const [g] = await tx.insert(groups).values({
        name: input.name, description: input.description ?? null, entraGroupId: input.entraGroupId || null,
        source: input.entraGroupId ? 'entra' : 'local',
      }).returning();
      if (input.memberIds?.length) await tx.insert(groupMembers).values(input.memberIds.map((userId) => ({ groupId: g.id, userId })));
      afterCommit(bumpAcl);
      return g;
    });
    return g;
  });

  app.patch<{ Params: { id: string } }>('/groups/:id', async (req) => {
    const { access } = auth(req);
    access.requireAdmin();
    const input = parse(groupSchema.partial(), req.body);
    const [g] = await db.select().from(groups).where(eq(groups.id, req.params.id));
    if (!g) throw new NotFound();
    if (g.isSystem && (input.name || input.memberIds)) throw new Validation('System groups cannot be renamed or edited');
    await runTx(async (tx) => {
      await tx.update(groups).set({
        ...(input.name ? { name: input.name } : {}),
        ...(input.description !== undefined ? { description: input.description } : {}),
        ...(input.entraGroupId !== undefined ? { entraGroupId: input.entraGroupId || null, source: input.entraGroupId ? 'entra' as const : 'local' as const } : {}),
      }).where(eq(groups.id, g.id));
      if (input.memberIds) {
        // local members are managed here; Entra-sourced members are replaced at each login
        await tx.delete(groupMembers).where(and(eq(groupMembers.groupId, g.id), eq(groupMembers.source, 'local')));
        if (input.memberIds.length) {
          await tx.insert(groupMembers).values(input.memberIds.map((userId) => ({ groupId: g.id, userId, source: 'local' as const }))).onConflictDoNothing();
        }
      }
      afterCommit(bumpAcl);
    });
    return { ok: true };
  });

  app.delete<{ Params: { id: string } }>('/groups/:id', async (req) => {
    const { access } = auth(req);
    access.requireAdmin();
    const [g] = await db.select().from(groups).where(eq(groups.id, req.params.id));
    if (!g) throw new NotFound();
    if (g.isSystem) throw new Validation('System groups cannot be deleted');
    await runTx(async (tx) => {
      await tx.execute(sql`delete from acl_entries where principal_type = 'group' and principal_id = ${g.id}`);
      await tx.delete(groups).where(eq(groups.id, g.id));
      afterCommit(bumpAcl);
    });
    return { ok: true };
  });

  app.get('/roles', async () => WORKSPACE_ROLES);
}
