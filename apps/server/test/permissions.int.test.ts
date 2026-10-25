/**
 * Permission matrix through the HTTP API (permissions.md §8) against the dev Postgres.
 * Surfaces checked per scenario: GET /tasks/:id, list query, search, sidebar tree, and writes.
 * Fixture (unique names, removed afterwards): Space S → Folder F → List L → Task T → Subtask ST; List L2.
 */
import './load-env';
import { eq, inArray } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app';
import { db, sqlClient } from '../src/db/client';
import { aclScopes, folders, lists, sessions, spaces, statusSets, users, workspaces } from '../src/db/schema';
import { bumpAcl } from '../src/lib/access';
import { rootScopeId, setSharing } from '../src/lib/acl';
import { randomToken, sha256 } from '../src/lib/crypto';
import { runTx } from '../src/lib/tx';
import { createStatusSet } from '../src/modules/hierarchy/service';
import { createTask, type TaskRow } from '../src/modules/tasks/service';

const tag = `pm${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`;
const word = `zq${tag}`; // unique search term
let app: FastifyInstance;
let S: string, F: string, L: string, L2: string;
let T: TaskRow, ST: TaskRow;
const people: Record<string, { id: string; cookie: string; csrf: string }> = {};

async function mkUser(name: string, role: 'owner' | 'admin' | 'member' | 'guest') {
  const [u] = await db.insert(users).values({ email: `${name}-${tag}@test.local`, displayName: `${name} ${tag}`, role }).returning();
  const token = randomToken();
  const csrf = randomToken(12);
  await db.insert(sessions).values({ id: sha256(token), userId: u.id, csrfToken: csrf, expiresAt: new Date(Date.now() + 3_600_000) });
  people[name] = { id: u.id, cookie: `sid=${token}; csrf=${csrf}`, csrf };
}

const as = (who: string) => ({
  get: (url: string) => app.inject({ method: 'GET', url, headers: { cookie: people[who].cookie } }),
  send: (method: 'POST' | 'PATCH' | 'PUT' | 'DELETE', url: string, payload?: unknown) =>
    app.inject({ method, url, payload: payload as object, headers: { cookie: people[who].cookie, 'x-csrf-token': people[who].csrf } }),
});

async function sees(who: string, task: TaskRow) {
  const byId = (await as(who).get(`/api/tasks/${task.id}`)).statusCode === 200;
  const listed = ((await as(who).get(`/api/tasks?listId=${task.listId}&includeSubtasks=true`)).json() as Array<{ id: string }>).some((t) => t.id === task.id);
  const found = ((await as(who).get(`/api/search?q=${word}`)).json() as { tasks: Array<{ id: string }> }).tasks.some((t) => t.id === task.id);
  // all surfaces must agree
  expect({ who, byId, listed, found }).toEqual({ who, byId, listed: byId, found: byId });
  return byId;
}

async function share(type: 'space' | 'folder' | 'list' | 'task', id: string, mode: 'inherit' | 'additive' | 'override', entries: Array<[string, 'view' | 'comment' | 'edit' | 'full']>) {
  await runTx((tx) => setSharing(tx, type, id, mode, entries.map(([who, level]) => ({ principalType: 'user' as const, principalId: people[who].id, level })), people.owner.id));
}
async function resetSharing() {
  for (const [type, id] of [['task', ST.id], ['task', T.id], ['list', L], ['list', L2], ['folder', F], ['space', S]] as const) await share(type, id, 'inherit', []);
}

beforeAll(async () => {
  for (const [n, r] of [['owner', 'owner'], ['admin', 'admin'], ['m1', 'member'], ['m2', 'member'], ['g1', 'guest']] as const) await mkUser(n, r);
  await runTx(async (tx) => {
    const [ws] = await tx.select().from(workspaces).limit(1);
    const root = await rootScopeId(tx);
    const [s] = await tx.insert(spaces).values({ workspaceId: ws.id, name: `S ${tag}`, keyPrefix: `P${tag.slice(-8).toUpperCase().replace(/[^A-Z0-9]/g, 'X')}`, aclScopeId: root }).returning();
    S = s.id;
    await tx.update(spaces).set({ statusSetId: await createStatusSet(tx, 'space', s.id) }).where(eq(spaces.id, s.id));
    const [f] = await tx.insert(folders).values({ spaceId: S, name: `F ${tag}`, aclScopeId: root }).returning();
    F = f.id;
    const [l] = await tx.insert(lists).values({ spaceId: S, folderId: F, name: `L ${tag}`, aclScopeId: root }).returning();
    const [l2] = await tx.insert(lists).values({ spaceId: S, name: `L2 ${tag}`, aclScopeId: root }).returning();
    L = l.id;
    L2 = l2.id;
    T = await createTask(tx, { listId: L, name: `T ${word}` }, { actorId: null, silent: true });
    ST = await createTask(tx, { listId: L, parentTaskId: T.id, name: `ST ${word}` }, { actorId: null, silent: true });
  });
  bumpAcl();
  app = await buildApp();
}, 60_000);

afterAll(async () => {
  if (S) {
    const sub = [F, L, L2, T?.id, ST?.id].filter(Boolean) as string[];
    await db.delete(aclScopes).where(inArray(aclScopes.objectId, [S, ...sub]));
    await db.delete(spaces).where(eq(spaces.id, S));
    await db.delete(statusSets).where(eq(statusSets.ownerId, S));
  }
  await db.delete(users).where(inArray(users.id, Object.values(people).map((p) => p.id)));
  bumpAcl();
  await app?.close();
  await sqlClient.end();
});

describe('permission matrix over HTTP', () => {
  it('row 1: default — members see and edit, guests see nothing (404, not 403)', async () => {
    await resetSharing();
    for (const who of ['owner', 'admin', 'm1', 'm2']) expect(await sees(who, T)).toBe(true);
    expect(await sees('g1', T)).toBe(false);
    expect((await as('g1').get(`/api/tasks/${T.id}`)).statusCode).toBe(404);
    expect((await as('m2').send('PATCH', `/api/tasks/${T.id}`, { name: `T ${word}` })).statusCode).toBe(200);
  });

  it('row 2: space override with m1 view — m1 read-only, m2 locked out, admin still full', async () => {
    await resetSharing();
    await share('space', S, 'override', [['m1', 'view']]);
    expect(await sees('m1', T)).toBe(true);
    expect((await as('m1').send('PATCH', `/api/tasks/${T.id}`, { name: 'nope' })).statusCode).toBe(403);
    expect((await as('m1').send('POST', '/api/comments/task/' + T.id, { body: { type: 'doc', content: [] } })).statusCode).toBe(403);
    expect(await sees('m2', T)).toBe(false);
    expect(await sees('admin', T)).toBe(true);
    const tree = (await as('m2').get('/api/hierarchy/tree')).json() as { spaces: Array<{ id: string }> };
    expect(tree.spaces.some((s) => s.id === S)).toBe(false);
  });

  it('row 4/5: task shared with a guest — comment allowed, edit capped, nav names only', async () => {
    await resetSharing();
    await share('task', T.id, 'additive', [['g1', 'full']]);
    expect(await sees('g1', T)).toBe(true);
    expect(await sees('g1', ST)).toBe(true); // subtask inherits
    expect((await as('g1').send('PATCH', `/api/tasks/${T.id}`, { priority: 2 })).statusCode).toBe(200); // capped to edit
    expect((await as('g1').send('DELETE', `/api/tasks/${T.id}`)).statusCode).toBe(403); // not full
    expect((await as('g1').send('PUT', `/api/hierarchy/sharing/task/${T.id}`, { mode: 'inherit', entries: [] })).statusCode).toBe(403);
    const tree = (await as('g1').get('/api/hierarchy/tree')).json() as { spaces: Array<{ id: string; navOnly: boolean; folders: Array<{ lists: Array<{ id: string; navOnly: boolean }> }> }> };
    const s = tree.spaces.find((x) => x.id === S)!;
    expect(s.navOnly).toBe(true);
    expect(s.folders[0].lists.find((l) => l.id === L)?.navOnly).toBe(true);
    expect(tree.spaces.flatMap((x) => x.folders.flatMap((f) => f.lists)).some((l) => l.id === L2)).toBe(false);
  });

  it('row 7: private subtask under an inherited task', async () => {
    await resetSharing();
    await share('task', ST.id, 'override', [['m2', 'full']]);
    expect(await sees('m1', T)).toBe(true);
    expect(await sees('m1', ST)).toBe(false);
    expect(await sees('m2', ST)).toBe(true);
    const detail = (await as('m1').get(`/api/tasks/${T.id}`)).json() as { subtaskCount: number; subtasks: unknown[] };
    expect(detail.subtaskCount).toBe(0);
    expect(detail.subtasks).toHaveLength(0);
  });

  it('row 11: folder override (m1 view) + list additive (m2 edit)', async () => {
    await resetSharing();
    await share('folder', F, 'override', [['m1', 'view']]);
    await share('list', L, 'additive', [['m2', 'edit']]);
    expect(await sees('m1', T)).toBe(true);
    expect((await as('m1').send('PATCH', `/api/tasks/${T.id}`, { priority: 3 })).statusCode).toBe(403);
    expect((await as('m2').send('PATCH', `/api/tasks/${T.id}`, { priority: 3 })).statusCode).toBe(200);
    expect(await sees('g1', T)).toBe(false);
  });

  it('row 12/13: moving a task re-points inherited access; an own additive scope moves with it', async () => {
    await resetSharing();
    await share('list', L, 'override', [['m1', 'full']]);
    await share('task', T.id, 'additive', [['g1', 'comment']]);
    expect(await sees('m2', T)).toBe(false);
    expect((await as('m1').send('PATCH', `/api/tasks/${T.id}`, { listId: L2 })).statusCode).toBe(200);
    const moved = { ...T, listId: L2 };
    expect(await sees('m2', moved)).toBe(true); // gained via L2's inherited default
    expect(await sees('g1', moved)).toBe(true); // still shared
    expect((await as('g1').send('PATCH', `/api/tasks/${T.id}`, { priority: 1 })).statusCode).toBe(403); // comment only
    expect((await as('m1').send('PATCH', `/api/tasks/${T.id}`, { listId: L })).statusCode).toBe(200);
  });

  it('row 14/15: demotion to guest and deactivation', async () => {
    await resetSharing();
    await db.update(users).set({ role: 'guest' }).where(eq(users.id, people.m1.id));
    bumpAcl();
    expect(await sees('m1', T)).toBe(false);
    await db.update(users).set({ role: 'member' }).where(eq(users.id, people.m1.id));
    expect((await as('admin').send('PATCH', `/api/users/${people.m2.id}`, { isActive: false })).statusCode).toBe(200);
    expect((await as('m2').get(`/api/tasks/${T.id}`)).statusCode).toBe(401); // sessions revoked
    await db.update(users).set({ isActive: true }).where(eq(users.id, people.m2.id));
    bumpAcl();
  });
});
