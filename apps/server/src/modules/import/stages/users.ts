import { and, eq, sql } from 'drizzle-orm';
import { db } from '../../../db/client';
import { groupMembers, groups, importUserMappings, users } from '../../../db/schema';
import { bumpAcl } from '../../../lib/access';
import { Validation } from '../../../lib/errors';
import { afterCommit, runTx } from '../../../lib/tx';
import type { ClickUpApi } from '../clickup/client';
import type { CuUser } from '../clickup/schemas';
import { ControlSignal, type ImportContext } from '../context';

type Mapping = typeof importUserMappings.$inferSelect;

/** ClickUp workspace role → ours (owner maps to admin: there is only one owner here). */
export const roleFor = (r: number | null | undefined) => (r === 1 || r === 2 ? 'admin' : r === 4 ? 'guest' : 'member') as 'admin' | 'member' | 'guest';

async function usersByEmail() {
  const rows = await db.select({ id: users.id, email: users.email, isSystem: users.isSystem }).from(users);
  return new Map(rows.filter((r) => !r.isSystem).map((r) => [r.email.toLowerCase(), r.id]));
}

/** Pure matching for one member against existing mapping + users (used by dry runs too). */
function resolve(m: CuUser, existing: Mapping | undefined, byEmail: Map<string, string>): { userId: string | null; resolution: Mapping['resolution'] } {
  if (existing && existing.resolution !== 'unresolved') return { userId: existing.userId, resolution: existing.resolution };
  const hit = m.email ? byEmail.get(m.email.toLowerCase()) : undefined;
  return hit ? { userId: hit, resolution: 'auto_email' } : { userId: null, resolution: 'unresolved' };
}

/** Fetch workspace members and upsert import_user_mappings (auto-matching by email). Not used by dry runs. */
export async function refreshUserMappings(api: ClickUpApi) {
  const ws = await api.getWorkspace();
  const byEmail = await usersByEmail();
  const existing = new Map((await db.select().from(importUserMappings)).map((r) => [r.clickupUserId, r]));
  let created = 0;
  for (const m of ws.members) {
    const cur = existing.get(m.id);
    const r = resolve(m, cur, byEmail);
    if (!cur) {
      await db.insert(importUserMappings).values({ clickupUserId: m.id, clickupEmail: m.email ?? null, clickupName: m.username ?? null, ...r });
      created++;
    } else {
      await db.update(importUserMappings).set({ clickupEmail: m.email ?? null, clickupName: m.username ?? null, ...r })
        .where(eq(importUserMappings.clickupUserId, m.id));
    }
  }
  return { workspace: ws, created };
}

export async function loadUserMap(): Promise<Map<string, string | null>> {
  const rows = await db.select().from(importUserMappings);
  return new Map(rows.filter((r) => r.resolution !== 'unresolved').map((r) => [r.clickupUserId, r.resolution === 'skip' ? null : r.userId]));
}

/** Resolve one ClickUp user: map to an existing user, create a placeholder (linked on first SSO login by email), or skip. */
export async function resolveUserMapping(clickupUserId: string, action: { kind: 'map'; userId: string } | { kind: 'placeholder'; role?: number | null } | { kind: 'skip' } | { kind: 'reset' }) {
  return runTx(async (tx) => {
    const [m] = await tx.select().from(importUserMappings).where(eq(importUserMappings.clickupUserId, clickupUserId));
    if (!m) throw new Validation('Unknown ClickUp user');
    if (action.kind === 'reset') {
      await tx.update(importUserMappings).set({ userId: null, resolution: 'unresolved' }).where(eq(importUserMappings.clickupUserId, clickupUserId));
      return;
    }
    if (action.kind === 'skip') {
      await tx.update(importUserMappings).set({ userId: null, resolution: 'skip' }).where(eq(importUserMappings.clickupUserId, clickupUserId));
      return;
    }
    if (action.kind === 'map') {
      const [u] = await tx.select({ id: users.id }).from(users).where(and(eq(users.id, action.userId), eq(users.isSystem, false)));
      if (!u) throw new Validation('Unknown user');
      await tx.update(importUserMappings).set({ userId: u.id, resolution: 'manual' }).where(eq(importUserMappings.clickupUserId, clickupUserId));
      return;
    }
    const email = (m.clickupEmail || `clickup-${clickupUserId}@placeholder.invalid`).toLowerCase();
    const [taken] = await tx.select({ id: users.id }).from(users).where(sql`lower(${users.email}) = ${email}`);
    let userId = taken?.id;
    if (!userId) {
      const [u] = await tx.insert(users).values({
        email, displayName: m.clickupName || email.split('@')[0], role: roleFor(action.role ?? null), isPlaceholder: true,
      }).returning({ id: users.id });
      userId = u.id;
    }
    await tx.update(importUserMappings).set({ userId, resolution: taken ? 'manual' : 'placeholder' }).where(eq(importUserMappings.clickupUserId, clickupUserId));
  });
}

/**
 * Stage 1: workspace members → user mappings (pauses for review when some are unresolved),
 * ClickUp user groups → local groups (matched by name).
 */
export async function runUsers(ctx: ImportContext) {
  const ws = ctx.dry ? await ctx.api.getWorkspace() : (await refreshUserMappings(ctx.api)).workspace;
  ctx.cursor.workspaceName = ws.name;
  ctx.progress(0, ws.members.length, 'members');
  if (ctx.dry) {
    const byEmail = await usersByEmail();
    const existing = new Map((await db.select().from(importUserMappings)).map((r) => [r.clickupUserId, r]));
    for (const m of ws.members) {
      ctx.stat('user', 'seen');
      const r = resolve(m, existing.get(m.id), byEmail);
      if (r.resolution === 'unresolved') {
        ctx.stat('user', 'skipped');
        ctx.issue('warn', 'user', m.id, `${m.username ?? m.email ?? m.id} (${m.email ?? 'no email'}) has no matching user; map them, create a placeholder or skip in the user mapping step`);
        ctx.users.set(m.id, null);
      } else {
        ctx.stat('user', 'unchanged');
        ctx.users.set(m.id, r.userId);
      }
    }
  } else {
    const all = await db.select().from(importUserMappings);
    const memberIds = new Set(ws.members.map((m) => m.id));
    const unresolved = all.filter((r) => memberIds.has(r.clickupUserId) && r.resolution === 'unresolved');
    if (unresolved.length) {
      ctx.cursor.awaitingUserMapping = true;
      ctx.issue('info', 'user', null, `${unresolved.length} ClickUp user(s) need a mapping decision before the import continues`);
      ctx.control = 'pause';
      await ctx.save();
      throw new ControlSignal('pause');
    }
    ctx.cursor.awaitingUserMapping = false;
    for (const r of all.filter((x) => memberIds.has(x.clickupUserId))) {
      ctx.stat('user', 'seen');
      ctx.stat('user', r.resolution === 'skip' ? 'skipped' : 'unchanged');
    }
    ctx.users = await loadUserMap();
  }
  for (const m of ws.members) {
    if (m.role === 4) ctx.dropped('guest_visibility_toggles');
  }
  await importGroups(ctx);
  await ctx.checkpoint(true);
}

async function importGroups(ctx: ImportContext) {
  const cuGroups = await ctx.api.getGroups();
  if (!cuGroups.length) return;
  const local = await db.select().from(groups);
  for (const g of cuGroups) {
    ctx.stat('group', 'seen');
    const mapped = await ctx.idOf('group', g.id);
    const byName = local.find((l) => l.name.toLowerCase() === g.name.toLowerCase() && !l.isSystem);
    const memberIds = g.members.map((u) => ctx.users.get(u.id)).filter((u): u is string => !!u);
    if (ctx.dry) {
      ctx.stat('group', mapped || byName ? 'unchanged' : 'created');
      continue;
    }
    await runTx(async (tx) => {
      let groupId = mapped ?? byName?.id ?? null;
      if (!groupId) {
        const [n] = await tx.insert(groups).values({ name: g.name, description: 'Imported from ClickUp' }).returning({ id: groups.id });
        groupId = n.id;
        ctx.stat('group', 'created');
      } else ctx.stat('group', 'unchanged');
      if (memberIds.length) {
        await tx.insert(groupMembers).values(memberIds.map((userId) => ({ groupId: groupId!, userId }))).onConflictDoNothing();
        afterCommit(bumpAcl);
      }
      await ctx.link(tx, 'group', g.id, groupId, null);
    });
  }
}
