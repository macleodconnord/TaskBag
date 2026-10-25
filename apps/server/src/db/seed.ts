import { plainToRichText } from '@app/shared';
import { and, eq, sql } from 'drizzle-orm';
import { db } from './client';
import { aclEntries, aclScopes, groups, lists, spaces, users, workspaces } from './schema';
import { log } from '../lib/log';
import { createStatusSet } from '../modules/hierarchy/service';
import { createTask } from '../modules/tasks/service';
import { runTx } from '../lib/tx';

export const SYSTEM_USERS = {
  ninjaone: { email: 'ninjaone@system.local', displayName: 'NinjaOne' },
  gitea: { email: 'gitea@system.local', displayName: 'Gitea' },
  clickup: { email: 'clickup-import@system.local', displayName: 'ClickUp import' },
} as const;

/** Idempotent: workspace, root ACL scope (All Members → edit), system group and system users. */
export async function ensureBaseData() {
  await db.transaction(async (tx) => {
    let [ws] = await tx.select().from(workspaces).limit(1);
    if (!ws) [ws] = await tx.insert(workspaces).values({ name: 'Workspace', settings: { timezone: 'America/Chicago' } }).returning();

    let [all] = await tx.select().from(groups).where(and(eq(groups.isSystem, true), eq(groups.name, 'All Members')));
    if (!all) {
      [all] = await tx.insert(groups).values({ name: 'All Members', description: 'Every member, admin and owner (not guests)', isSystem: true }).returning();
    }
    let [root] = await tx.select().from(aclScopes).where(eq(aclScopes.objectType, 'workspace'));
    if (!root) {
      [root] = await tx.insert(aclScopes).values({ objectType: 'workspace', objectId: ws.id, parentScopeId: null, mode: 'override' }).returning();
      await tx.insert(aclEntries).values({ scopeId: root.id, principalType: 'group', principalId: all.id, level: 'edit' });
    }
    for (const u of Object.values(SYSTEM_USERS)) {
      await tx.insert(users).values({ ...u, isSystem: true, role: 'member' }).onConflictDoNothing();
    }
  });
}

export async function systemUserId(key: keyof typeof SYSTEM_USERS): Promise<string> {
  const [u] = await db.select({ id: users.id }).from(users).where(sql`lower(${users.email}) = ${SYSTEM_USERS[key].email}`);
  if (!u) throw new Error(`System user ${key} missing`);
  return u.id;
}

/** Development data: people for the dev login and a sample space. */
export async function seedDev() {
  await ensureBaseData();
  const people = [
    { email: 'owner@example.com', displayName: 'Olivia Owner', role: 'owner' as const },
    { email: 'admin@example.com', displayName: 'Adam Admin', role: 'admin' as const },
    { email: 'maria@example.com', displayName: 'Maria Member', role: 'member' as const },
    { email: 'sam@example.com', displayName: 'Sam Member', role: 'member' as const },
    { email: 'gail@example.com', displayName: 'Gail Guest', role: 'guest' as const },
  ];
  for (const p of people) await db.insert(users).values(p).onConflictDoNothing();
  const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(spaces);
  if (n > 0) {
    log.info('dev seed: spaces exist, skipping sample data');
    return;
  }
  const byEmail = async (e: string) => (await db.select().from(users).where(eq(users.email, e)))[0];
  const owner = await byEmail('owner@example.com');
  const maria = await byEmail('maria@example.com');
  const sam = await byEmail('sam@example.com');

  await runTx(async (tx) => {
    const [ws] = await tx.select().from(workspaces).limit(1);
    const [root] = await tx.select().from(aclScopes).where(eq(aclScopes.objectType, 'workspace'));
    const [space] = await tx.insert(spaces).values({ workspaceId: ws.id, name: 'Operations', keyPrefix: 'OPS', color: '#6366f1', aclScopeId: root.id }).returning();
    const setId = await createStatusSet(tx, 'space', space.id);
    await tx.update(spaces).set({ statusSetId: setId }).where(eq(spaces.id, space.id));
    const [l1] = await tx.insert(lists).values({ spaceId: space.id, name: 'Sprint backlog', aclScopeId: root.id, position: 0 }).returning();
    const [l2] = await tx.insert(lists).values({ spaceId: space.id, name: 'Infrastructure', aclScopeId: root.id, position: 1 }).returning();
    const day = 86_400_000;
    const samples = [
      { listId: l1.id, name: 'Set up the new project app', assigneeIds: [owner.id], dueAt: new Date(Date.now() + day).toISOString(), priority: 2 },
      { listId: l1.id, name: 'Import ClickUp workspace', assigneeIds: [maria.id], dueAt: new Date(Date.now() + 3 * day).toISOString(), priority: 1 },
      { listId: l1.id, name: 'Write onboarding guide', assigneeIds: [sam.id], priority: 3, description: plainToRichText('Cover sign-in, spaces and lists, and how sharing works.') },
      { listId: l1.id, name: 'Review permissions for guests', assigneeIds: [maria.id, sam.id], dueAt: new Date(Date.now() - day).toISOString() },
      { listId: l2.id, name: 'Patch the VM', assigneeIds: [sam.id], priority: 2, dueAt: new Date(Date.now() + 7 * day).toISOString() },
      { listId: l2.id, name: 'Configure SMTP relay', assigneeIds: [owner.id] },
    ];
    for (const s of samples) await createTask(tx, s, { actorId: owner.id, silent: true });
  });
  log.info('dev seed: created sample space "Operations"');
}

