/**
 * List ↔ Task link rollups against the real dev Postgres — permissions.md §8 rows 16–17.
 * Fixture (own data, unique names, removed afterwards): Space S → List L (tasks T, T2), List L2 (task P linked to L).
 */
import './load-env';
import { eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db, sqlClient } from '../src/db/client';
import { aclScopes, lists, spaces, statusSets, users, workspaces } from '../src/db/schema';
import { AccessContext, bumpAcl } from '../src/lib/access';
import { makePrivate, rootScopeId, setSharing } from '../src/lib/acl';
import { runTx } from '../src/lib/tx';
import { createStatusSet } from '../src/modules/hierarchy/service';
import { setup as listLinksSetup } from '../src/modules/list-links/setup';
import { linkedFromTask, linkTaskToList, wouldCycle } from '../src/modules/list-links/service';
import { createTask, hydrateTasks, runDetailExtensions, type TaskRow } from '../src/modules/tasks/service';

const tag = `ll${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`;
let spaceId: string;
let L: string;
let L2: string;
let T: TaskRow;
let T2: TaskRow;
let P: TaskRow;
let m1: AccessContext;
let m2: AccessContext;
const userIds: string[] = [];

async function mkUser(name: string) {
  const [u] = await db.insert(users).values({ email: `${name}-${tag}@test.local`, displayName: `${name} ${tag}`, role: 'member' }).returning();
  userIds.push(u.id);
  return new AccessContext({ id: u.id, role: 'member', isActive: true });
}

const detailOf = async (task: TaskRow, access: AccessContext) => (await runDetailExtensions(db, task, access)).linkedList as Record<string, unknown> | null;
const chipOf = async (task: TaskRow, access: AccessContext) => (await hydrateTasks(db, [task], access))[0].linkedList as Record<string, unknown> | undefined;

beforeAll(async () => {
  await listLinksSetup();
  m1 = await mkUser('m1');
  m2 = await mkUser('m2');
  await runTx(async (tx) => {
    const [ws] = await tx.select().from(workspaces).limit(1);
    const root = await rootScopeId(tx);
    const [s] = await tx.insert(spaces).values({ workspaceId: ws.id, name: `S ${tag}`, keyPrefix: `T${tag.slice(-8).toUpperCase().replace(/[^A-Z0-9]/g, 'X')}`, aclScopeId: root }).returning();
    spaceId = s.id;
    await tx.update(spaces).set({ statusSetId: await createStatusSet(tx, 'space', s.id) }).where(eq(spaces.id, s.id));
    const [l] = await tx.insert(lists).values({ spaceId: s.id, name: `L ${tag}`, aclScopeId: root }).returning();
    const [l2] = await tx.insert(lists).values({ spaceId: s.id, name: `L2 ${tag}`, aclScopeId: root }).returning();
    L = l.id;
    L2 = l2.id;
    T = await createTask(tx, { listId: L, name: 'T', timeEstimateMin: 60 }, { actorId: m1.user.id, silent: true });
    T2 = await createTask(tx, { listId: L, name: 'T2', timeEstimateMin: 15 }, { actorId: m1.user.id, silent: true });
    P = await createTask(tx, { listId: L2, name: 'P' }, { actorId: m1.user.id, silent: true });
    await linkTaskToList(tx, P, L, m1.user.id);
  });
  bumpAcl();
}, 30_000);

afterAll(async () => {
  if (spaceId) {
    const lsIds = [L, L2].filter(Boolean);
    const taskIds = [T?.id, T2?.id, P?.id].filter(Boolean) as string[];
    await db.delete(aclScopes).where(inArray(aclScopes.objectId, [...lsIds, ...taskIds]));
    await db.delete(spaces).where(eq(spaces.id, spaceId)); // cascades lists, tasks, links
    await db.delete(statusSets).where(eq(statusSets.ownerId, spaceId));
  }
  if (userIds.length) await db.delete(users).where(inArray(users.id, userIds));
  bumpAcl();
  await sqlClient.end();
});

describe('List ↔ Task link rollups (permissions matrix rows 16–17)', () => {
  it('baseline: both members see the full rollup', async () => {
    for (const a of [m1, m2]) {
      const r = await detailOf(P, a);
      expect(r).toMatchObject({ hidden: false, listId: L, total: 2, done: 0, estimateMin: 75 });
    }
  });

  it('row 16: L private to m1 → m1 gets counts, m2 gets { hidden: true } with no name or counts', async () => {
    await runTx((tx) => makePrivate(tx, 'list', L, m1.user.id));
    try {
      expect(await m2.levelOf('task', P.id)).not.toBe('none'); // P itself stays visible to m2

      const forM1 = await detailOf(P, m1);
      expect(forM1).toMatchObject({ hidden: false, name: `L ${tag}`, total: 2, estimateMin: 75 });
      expect(await chipOf(P, m1)).toMatchObject({ hidden: false, total: 2 });

      for (const r of [await detailOf(P, m2), await chipOf(P, m2)]) {
        expect(r).toEqual({ hidden: true });
      }
      // the breadcrumb on L still works for m1; m2 can't open L at all
      expect(await linkedFromTask(db, L, m1)).toMatchObject({ id: P.id, name: 'P' });
    } finally {
      await runTx((tx) => setSharing(tx, 'list', L, 'inherit', [], m1.user.id));
    }
  });

  it('row 17: L visible to m2 but T private to m1 → m2’s rollup excludes T', async () => {
    await runTx((tx) => makePrivate(tx, 'task', T.id, m1.user.id));
    try {
      expect(await m2.levelOf('list', L)).not.toBe('none');
      expect(await m2.levelOf('task', T.id)).toBe('none');

      expect(await detailOf(P, m1)).toMatchObject({ hidden: false, total: 2, estimateMin: 75 });
      const forM2 = await detailOf(P, m2);
      expect(forM2).toMatchObject({ hidden: false, total: 1, estimateMin: 15 });
      expect((forM2!.preview as Array<{ id: string }>).map((t) => t.id)).toEqual([T2.id]);
      expect(await chipOf(P, m2)).toMatchObject({ hidden: false, total: 1, estimateMin: 15 });
    } finally {
      await runTx((tx) => setSharing(tx, 'task', T.id, 'inherit', [], m1.user.id));
    }
  });

  it('cycle check: own list and lists whose subtree contains the task’s list are rejected', async () => {
    expect(await wouldCycle(db, L2, L2)).toBe(true); // own list
    expect(await wouldCycle(db, L, L2)).toBe(true); // L2 → (P) → L: linking a task in L to L2 closes the loop
    expect(await wouldCycle(db, L2, L)).toBe(false);
    await expect(runTx((tx) => linkTaskToList(tx, T2, L2, m1.user.id))).rejects.toThrow(/cycle/);
    await expect(runTx((tx) => linkTaskToList(tx, T2, L, m1.user.id))).rejects.toThrow(/own list/);
  });
});
