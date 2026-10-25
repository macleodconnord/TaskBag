/**
 * ClickUp importer end to end against the dev Postgres, fed by recorded fixtures (no network):
 * dry run writes nothing, full import maps everything, a second run creates 0 rows, a delta run
 * updates a changed task. Everything created here is removed afterwards.
 */
import './load-env';
import { createHash } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db, sqlClient } from '../src/db/client';
import {
  aclEntries, aclScopes, attachments, checklistItems, checklists, comments, customFields, docs, externalIds, folders, groupMembers, groups,
  importIssues, importRuns, importUserMappings, lists, spaces, statuses, statusSets, tags, taskAssignees, taskDependencies,
  taskFieldValues, taskLinks, tasks, taskTags, users, views,
} from '../src/db/schema';
import { bumpAcl } from '../src/lib/access';
import { setClickUpClientFactory } from '../src/modules/import/clickup/client';
import { SOURCE, type RunCursor } from '../src/modules/import/context';
import { buildReport, reportCsv } from '../src/modules/import/report';
import { createRun, launch, openRun, resumeRun, activeRun } from '../src/modules/import/runner';
import { resolveUserMapping } from '../src/modules/import/stages/users';
import { storagePath } from '../src/modules/attachments/routes';
import { FixtureClickUpClient, loadRecording } from './clickup-fixture-client';

const FIXTURE_USERS = ['81000001', '81000002', '81000003', '99999999'];
const CASEY_EMAIL = 'casey.contractor@fixture.invalid';
let client = new FixtureClickUpClient();
const runIds: string[] = [];

const ext = async (entity: string, id: string) => {
  const [r] = await db.select().from(externalIds).where(and(eq(externalIds.source, SOURCE), eq(externalIds.entity, entity), eq(externalIds.externalId, id)));
  return r?.internalId ?? null;
};
const taskByExt = async (id: string) => {
  const internal = await ext('task', id);
  return internal ? (await db.select().from(tasks).where(eq(tasks.id, internal)))[0] : undefined;
};

async function runToEnd(mode: 'dry_run' | 'full' | 'delta', since?: Date) {
  const run = await createRun({ mode, startedBy: null, since: since ?? null });
  runIds.push(run.id);
  await launch(run.id);
  const [r] = await db.select().from(importRuns).where(eq(importRuns.id, run.id));
  return r;
}

/** Rows that belong to the fixture space, table by table. */
async function fixtureCounts() {
  const spaceId = await ext('space', '90110000101');
  if (!spaceId) return {};
  const listIds = (await db.select({ id: lists.id }).from(lists).where(eq(lists.spaceId, spaceId))).map((r) => r.id);
  const folderIds = (await db.select({ id: folders.id }).from(folders).where(eq(folders.spaceId, spaceId))).map((r) => r.id);
  const taskIds = (await db.select({ id: tasks.id }).from(tasks).where(inArray(tasks.listId, listIds))).map((r) => r.id);
  const setIds = [
    ...(await db.select({ id: statusSets.id }).from(statusSets).where(inArray(statusSets.ownerId, [spaceId, ...listIds]))).map((r) => r.id),
  ];
  const n = async (q: Promise<Array<{ n: number }>>) => (await q)[0].n;
  const cnt = sql<number>`count(*)::int`;
  return {
    spaces: 1,
    folders: folderIds.length,
    lists: listIds.length,
    statusSets: setIds.length,
    statuses: await n(db.select({ n: cnt }).from(statuses).where(inArray(statuses.statusSetId, setIds))),
    tasks: taskIds.length,
    assignees: await n(db.select({ n: cnt }).from(taskAssignees).where(inArray(taskAssignees.taskId, taskIds))),
    taskTags: await n(db.select({ n: cnt }).from(taskTags).where(inArray(taskTags.taskId, taskIds))),
    tags: await n(db.select({ n: cnt }).from(tags).where(eq(tags.spaceId, spaceId))),
    checklists: await n(db.select({ n: cnt }).from(checklists).where(inArray(checklists.taskId, taskIds))),
    checklistItems: await n(db.select({ n: cnt }).from(checklistItems).innerJoin(checklists, eq(checklists.id, checklistItems.checklistId)).where(inArray(checklists.taskId, taskIds))),
    deps: await n(db.select({ n: cnt }).from(taskDependencies).where(inArray(taskDependencies.taskId, taskIds))),
    links: await n(db.select({ n: cnt }).from(taskLinks).where(inArray(taskLinks.taskAId, taskIds))),
    fields: await n(db.select({ n: cnt }).from(customFields).where(inArray(customFields.scopeId, [spaceId, ...folderIds, ...listIds]))),
    fieldValues: await n(db.select({ n: cnt }).from(taskFieldValues).where(inArray(taskFieldValues.taskId, taskIds))),
    comments: await n(db.select({ n: cnt }).from(comments).where(inArray(comments.taskId, taskIds))),
    attachments: await n(db.select({ n: cnt }).from(attachments).where(inArray(attachments.taskId, taskIds))),
    docs: await n(db.select({ n: cnt }).from(docs).where(inArray(docs.containerId, [spaceId, ...folderIds, ...listIds]))),
    views: await n(db.select({ n: cnt }).from(views).where(inArray(views.scopeId, [spaceId, ...folderIds, ...listIds]))),
    scopes: await n(db.select({ n: cnt }).from(aclScopes).where(inArray(aclScopes.objectId, [spaceId, ...folderIds, ...listIds, ...taskIds]))),
    externalIds: await n(db.select({ n: cnt }).from(externalIds).where(eq(externalIds.source, SOURCE))),
  };
}

async function cleanup() {
  // everything the fixture runs mapped (also from crashed earlier runs)
  const fixtureRuns = (await db.select({ id: importRuns.id, cursor: importRuns.cursor }).from(importRuns))
    .filter((r) => (r.cursor as RunCursor).workspaceName === 'Acme (fixture)' || runIds.includes(r.id)).map((r) => r.id);
  const mapped = fixtureRuns.length ? await db.select().from(externalIds).where(and(eq(externalIds.source, SOURCE), inArray(externalIds.importRunId, fixtureRuns))) : [];
  const ids = (entity: string) => mapped.filter((m) => m.entity === entity).map((m) => m.internalId);
  const fixtureSpaces = [...ids('space'), ...(await db.select({ id: spaces.id }).from(spaces).where(eq(spaces.name, 'Fixture Engineering'))).map((r) => r.id)];
  if (fixtureSpaces.length) {
    const listIds = (await db.select({ id: lists.id }).from(lists).where(inArray(lists.spaceId, fixtureSpaces))).map((r) => r.id);
    const folderIds = (await db.select({ id: folders.id }).from(folders).where(inArray(folders.spaceId, fixtureSpaces))).map((r) => r.id);
    const taskIds = listIds.length ? (await db.select({ id: tasks.id }).from(tasks).where(inArray(tasks.listId, listIds))).map((r) => r.id) : [];
    const files = taskIds.length ? await db.select({ k: attachments.storageKey }).from(attachments).where(inArray(attachments.taskId, taskIds)) : [];
    for (const f of files) await rm(storagePath(f.k), { force: true });
    const containers = [...fixtureSpaces, ...folderIds, ...listIds];
    await db.delete(docs).where(inArray(docs.containerId, containers));
    await db.delete(views).where(inArray(views.scopeId, containers));
    await db.delete(customFields).where(inArray(customFields.scopeId, containers));
    await db.delete(statusSets).where(inArray(statusSets.ownerId, [...fixtureSpaces, ...listIds]));
    await db.delete(aclScopes).where(inArray(aclScopes.objectId, [...containers, ...taskIds]));
    await db.delete(spaces).where(inArray(spaces.id, fixtureSpaces));
  }
  for (const [entity, table] of [['view', views], ['doc', docs], ['field', customFields]] as const) {
    const own = ids(entity);
    if (own.length) await db.delete(table).where(inArray(table.id, own));
  }
  const g = ids('group');
  if (g.length) await db.delete(groups).where(inArray(groups.id, g));
  await db.delete(groups).where(eq(groups.name, 'Fixture Engineers'));
  if (fixtureRuns.length) {
    await db.delete(externalIds).where(and(eq(externalIds.source, SOURCE), inArray(externalIds.importRunId, fixtureRuns)));
    await db.delete(importRuns).where(inArray(importRuns.id, fixtureRuns));
  }
  await db.delete(importUserMappings).where(inArray(importUserMappings.clickupUserId, FIXTURE_USERS));
  await db.delete(users).where(sql`lower(${users.email}) = ${CASEY_EMAIL}`);
  bumpAcl();
}

beforeAll(async () => {
  const open = await openRun();
  if (open && (open.cursor as RunCursor).workspaceName !== 'Acme (fixture)') {
    throw new Error(`An import run is open in this database (${open.id}, ${open.status}); cancel it before running these tests`);
  }
  await cleanup();
  setClickUpClientFactory(async () => client);
}, 60_000);

afterAll(async () => {
  setClickUpClientFactory(null);
  await cleanup();
  await sqlClient.end();
}, 60_000);

describe('ClickUp import', () => {
  it('dry run writes nothing but import_runs and import_issues', async () => {
    const before = await db.select({ n: sql<number>`count(*)::int` }).from(externalIds);
    const usersBefore = await db.select({ n: sql<number>`count(*)::int` }).from(users);
    const run = await runToEnd('dry_run');
    expect(run.status).toBe('succeeded');
    expect(await ext('space', '90110000101')).toBeNull();
    expect((await db.select({ n: sql<number>`count(*)::int` }).from(externalIds))[0].n).toBe(before[0].n);
    expect((await db.select({ n: sql<number>`count(*)::int` }).from(users))[0].n).toBe(usersBefore[0].n);
    expect(await db.select().from(importUserMappings).where(inArray(importUserMappings.clickupUserId, FIXTURE_USERS))).toHaveLength(0);
    const stats = run.stats;
    expect(stats.space.created).toBe(1);
    expect(stats.list.created).toBe(3);
    expect(stats.task.created).toBe(6);
    expect(stats.comment.created).toBe(4);
    expect(stats.view.created).toBe(3);
    expect(stats.view.skipped).toBe(1);
    const report = await buildReport(run.id);
    const msgs = report.issues.map((i) => i.message).join('\n');
    expect(msgs).toMatch(/Effort score.*unsupported type "formula"/);
    expect(msgs).toMatch(/Casey Contractor .* has no matching user/);
    expect(msgs).toMatch(/Time entries are not imported/);
    expect(msgs).toMatch(/watcher/);
    expect(msgs).toMatch(/Company wiki.*workspace level/);
    expect(reportCsv(report)).toContain('section,entity,severity');
  }, 60_000);

  it('full import pauses for user mapping, then imports everything', async () => {
    let run = await runToEnd('full');
    expect(run.status).toBe('paused');
    expect((run.cursor as RunCursor).awaitingUserMapping).toBe(true);
    const maps = await db.select().from(importUserMappings).where(inArray(importUserMappings.clickupUserId, FIXTURE_USERS));
    expect(maps.find((m) => m.clickupUserId === '81000001')?.resolution).toBe('auto_email');
    expect(maps.find((m) => m.clickupUserId === '81000002')?.resolution).toBe('unresolved');
    await resolveUserMapping('81000002', { kind: 'placeholder', role: 4 });
    await resumeRun(run.id);
    await activeRun()?.done;
    [run] = await db.select().from(importRuns).where(eq(importRuns.id, run.id));
    const issues = await db.select().from(importIssues).where(and(eq(importIssues.importRunId, run.id), eq(importIssues.severity, 'error')));
    expect(issues.map((i) => i.message)).toEqual([]);
    expect(run.status).toBe('succeeded');

    const [casey] = await db.select().from(users).where(sql`lower(${users.email}) = ${CASEY_EMAIL}`);
    expect(casey.isPlaceholder).toBe(true);
    expect(casey.role).toBe('guest');
    const [maria] = await db.select().from(users).where(sql`lower(${users.email}) = 'maria@example.com'`);
    const [olivia] = await db.select().from(users).where(sql`lower(${users.email}) = 'owner@example.com'`);

    // hierarchy + statuses
    const [space] = await db.select().from(spaces).where(eq(spaces.id, (await ext('space', '90110000101'))!));
    expect(space.keyPrefix).toMatch(/^FE\d*$/);
    const spaceStatuses = await db.select().from(statuses).where(eq(statuses.statusSetId, space.statusSetId!));
    expect(spaceStatuses.map((s) => `${s.name}:${s.group}`).sort()).toEqual(['complete:closed', 'in progress:active', 'review:active', 'to do:open']);
    const [bugs] = await db.select().from(lists).where(eq(lists.id, (await ext('list', '901100002002'))!));
    expect(bugs.folderId).toBeNull();
    expect(bugs.statusSetId).not.toBeNull();
    const [sprint] = await db.select().from(lists).where(eq(lists.id, (await ext('list', '901100002001'))!));
    expect(sprint.folderId).toBe(await ext('folder', '901100001001'));

    // tasks
    const t1 = (await taskByExt('86fx00001'))!;
    expect(t1.key).toMatch(new RegExp(`^${space.keyPrefix}-\\d+$`));
    expect(t1.source).toBe('clickup');
    expect(t1.priority).toBe(2);
    expect(t1.timeEstimateMin).toBe(90);
    expect(t1.dueAt?.getTime()).toBe(1736000000000);
    expect(t1.dueHasTime).toBe(true);
    expect(t1.createdAt.getTime()).toBe(1735600000000);
    expect(t1.updatedAt.getTime()).toBe(1735800000000);
    expect(t1.createdBy).toBe(olivia.id);
    const desc = JSON.stringify(t1.description);
    expect(desc).toContain('"type":"heading"');
    expect(desc).toContain('"type":"bold"');
    expect(desc).toContain('"type":"bulletList"');
    expect(desc).toContain('"type":"orderedList"');
    expect(desc).toContain('"href":"https://example.com/spec"');
    expect(desc).toContain('"type":"code"');
    expect((await db.select().from(taskAssignees).where(eq(taskAssignees.taskId, t1.id))).map((a) => a.userId)).toEqual([maria.id]);
    const t1Tags = await db.select({ name: tags.name }).from(taskTags).innerJoin(tags, eq(tags.id, taskTags.tagId)).where(eq(taskTags.taskId, t1.id));
    expect(t1Tags.map((t) => t.name)).toEqual(['frontend']);
    const t4 = (await taskByExt('86fx00004'))!;
    const t4Tags = await db.select({ name: tags.name }).from(taskTags).innerJoin(tags, eq(tags.id, taskTags.tagId)).where(eq(taskTags.taskId, t4.id));
    expect(t4Tags.map((t) => t.name).sort()).toEqual(['auth', 'frontend']); // tags are per space, case-insensitive
    expect(t4.completedAt?.getTime()).toBe(1735550000000);
    expect(t4.priority).toBe(1);

    const sub = (await taskByExt('86fx00002'))!;
    expect(sub.parentTaskId).toBe(t1.id);
    expect((await db.select().from(taskAssignees).where(eq(taskAssignees.taskId, sub.id))).map((a) => a.userId)).toEqual([casey.id]);
    expect((await taskByExt('86fx00005'))!.archivedAt).not.toBeNull();
    const inbox = (await taskByExt('86fx00006'))!;
    expect(inbox.createdBy).not.toBe(maria.id); // unknown creator → system user
    expect(inbox.descriptionText).toContain('Call the vendor *today*');

    // checklists (nested)
    const [cl] = await db.select().from(checklists).where(eq(checklists.taskId, t1.id));
    const items = await db.select().from(checklistItems).where(eq(checklistItems.checklistId, cl.id));
    expect(items).toHaveLength(3);
    const parentItem = items.find((i) => i.name === 'Test on mobile')!;
    expect(parentItem.assigneeId).toBe(maria.id);
    expect(items.find((i) => i.name === 'iOS Safari')!.parentItemId).toBe(parentItem.id);
    expect(items.find((i) => i.name === 'Test in Chrome')!.resolved).toBe(true);

    // custom fields
    const fv = new Map((await db.select({ name: customFields.name, type: customFields.type, scopeType: customFields.scopeType, value: taskFieldValues.value })
      .from(taskFieldValues).innerJoin(customFields, eq(customFields.id, taskFieldValues.fieldId)).where(eq(taskFieldValues.taskId, t1.id))).map((r) => [r.name, r]));
    expect(fv.get('Severity')).toMatchObject({ type: 'dropdown', scopeType: 'space', value: '0a0b0c0d-0001-4000-8000-000000000001' });
    expect(fv.get('Story points')?.value).toBe(5);
    expect(fv.get('Ship date')).toMatchObject({ type: 'date', scopeType: 'list', value: new Date(1736200000000).toISOString() });
    expect(fv.get('Reviewed')?.value).toBe(true);
    expect(fv.get('Areas')?.value).toEqual(['1b2c3d4e-0001-4000-8000-000000000001', '1b2c3d4e-0002-4000-8000-000000000002']);
    expect(fv.get('Reviewer')?.value).toEqual([maria.id]);
    expect(fv.get('Related bug')?.value).toEqual([(await taskByExt('86fx00003'))!.id]);
    expect(fv.has('Effort score')).toBe(false);
    const sevField = await db.select().from(customFields).where(eq(customFields.id, (await ext('field', 'f1a1b2c3-0001-4000-8000-0000000000a1@space:90110000101'))!));
    expect((sevField[0].config as { options: unknown[] }).options).toHaveLength(2);
    // t4's dropdown value uses the newer option-id form
    const [t4Sev] = await db.select().from(taskFieldValues).where(and(eq(taskFieldValues.taskId, t4.id), eq(taskFieldValues.fieldId, sevField[0].id)));
    expect(t4Sev.value).toBe('0a0b0c0d-0002-4000-8000-000000000002');

    // dependencies + links (deduplicated)
    expect(await db.select().from(taskDependencies).where(eq(taskDependencies.taskId, t1.id))).toEqual([{ taskId: t1.id, dependsOnTaskId: t4.id }]);
    expect(await db.select().from(taskLinks).where(inArray(taskLinks.taskAId, [t1.id, inbox.id]))).toHaveLength(1);

    // comments: threaded, author + time kept, mention mapped
    const cs = await db.select().from(comments).where(eq(comments.taskId, t1.id));
    expect(cs).toHaveLength(3);
    const top = cs.find((c) => c.sourceExternal === 'clickup:90110300001')!;
    expect(top.authorId).toBe(olivia.id);
    expect(top.createdAt.getTime()).toBe(1735810000000);
    expect(JSON.stringify(top.body)).toContain(`"type":"mention","attrs":{"id":"${maria.id}"`);
    expect(JSON.stringify(top.body)).toContain('"type":"bulletList"');
    const reply = cs.find((c) => c.sourceExternal === 'clickup:90110300003')!;
    expect(reply.parentId).toBe(top.id);
    expect(reply.authorId).toBe(maria.id);
    const [orphan] = await db.select().from(comments).where(eq(comments.taskId, inbox.id));
    expect(orphan.bodyText).toContain('Former Employee wrote:');

    // attachments with sha256 (task + comment file)
    const files = await db.select().from(attachments).where(and(eq(attachments.taskId, t1.id), isNull(attachments.deletedAt)));
    expect(files.map((f) => f.filename).sort()).toEqual(['notes.txt', 'spec.txt']);
    const spec = files.find((f) => f.filename === 'spec.txt')!;
    expect(spec.sha256).toBe(createHash('sha256').update('ClickUp spec v1\n').digest('hex'));
    expect(spec.uploaderId).toBe(olivia.id);
    expect(files.find((f) => f.filename === 'notes.txt')!.commentId).not.toBeNull();

    // docs: nesting preserved, container scope
    const handbook = (await db.select().from(docs).where(eq(docs.id, (await ext('doc', 'doc:8cfx-1001'))!)))[0];
    expect(handbook.containerType).toBe('space');
    expect(handbook.containerId).toBe(space.id);
    expect(handbook.aclScopeId).toBe(space.aclScopeId);
    const welcome = (await db.select().from(docs).where(eq(docs.id, (await ext('doc', 'page:8cfx-1001-p1'))!)))[0];
    expect(welcome.parentDocId).toBe(handbook.id);
    const setup = (await db.select().from(docs).where(eq(docs.id, (await ext('doc', 'page:8cfx-1001-p2'))!)))[0];
    expect(setup.parentDocId).toBe(welcome.id);
    expect(JSON.stringify(setup.content)).toContain('"type":"taskItem","attrs":{"checked":true}');

    // views
    const board = (await db.select().from(views).where(eq(views.id, (await ext('view', '3c-fx-board-1'))!)))[0];
    expect(board).toMatchObject({ type: 'board', scopeType: 'space', scopeId: space.id, visibility: 'shared' });
    expect(board.config).toMatchObject({ groupBy: 'status', sort: [{ field: 'due_at', dir: 'asc' }], showSubtasks: true });
    expect((board.config as { filters: { conditions: unknown[] } }).filters.conditions).toEqual([
      { field: 'assignee', op: 'any_of', value: [maria.id] },
      { field: 'priority', op: 'any_of', value: [1, 2] },
    ]);
    const table = (await db.select().from(views).where(eq(views.id, (await ext('view', '3c-fx-table-1'))!)))[0];
    expect(table.visibility).toBe('personal');
    expect(table.ownerId).toBe(maria.id);
    expect((table.config as { columns: string[] }).columns).toEqual(['assignee', 'due_at', `cf:${await ext('field', 'f1a1b2c3-0002-4000-8000-0000000000a2@space:90110000101')}`]);
    expect(await ext('view', '3c-fx-doc-1')).toBeNull();
    const everything = (await db.select().from(views).where(eq(views.id, (await ext('view', '3c-fx-everything-1'))!)))[0];
    expect(everything.scopeType).toBe('everything');

    // sharing: private list → override scope with its members
    expect(bugs.aclScopeId).not.toBe(space.aclScopeId);
    const [scope] = await db.select().from(aclScopes).where(eq(aclScopes.id, bugs.aclScopeId));
    expect(scope.mode).toBe('override');
    const entries = await db.select().from(aclEntries).where(eq(aclEntries.scopeId, scope.id));
    expect(entries.map((e) => `${e.principalId}:${e.level}`).sort()).toEqual([`${casey.id}:edit`, `${maria.id}:edit`].sort());
    expect((await taskByExt('86fx00003'))!.aclScopeId).toBe(bugs.aclScopeId);

    // groups
    const [grp] = await db.select().from(groups).where(eq(groups.id, (await ext('group', 'C9F1A2B3-0000-4000-8000-000000000001'))!));
    expect(grp.name).toBe('Fixture Engineers');
    expect((await db.select().from(groupMembers).where(eq(groupMembers.groupId, grp.id))).map((m) => m.userId)).toEqual([maria.id]);

    // validation (M-12)
    const v = (run.cursor as RunCursor).validation!;
    expect(v.lists.map((l) => [l.clickup, l.ours])).toEqual([[4, 4], [1, 1], [1, 1]]);
    expect(v.fields.checked).toBeGreaterThan(5);
    expect(v.fields.mismatches).toEqual([]);
    expect(v.attachments.checked).toBe(2);
    expect(v.attachments.mismatches).toEqual([]);
    expect(v.ok).toBe(true);
  }, 120_000);

  it('a second full run creates 0 new rows', async () => {
    const before = await fixtureCounts();
    const run = await runToEnd('full');
    expect(run.status).toBe('succeeded');
    expect(await fixtureCounts()).toEqual(before);
    const created = Object.entries(run.stats).filter(([k, s]) => (s.created ?? 0) > 0 && k !== 'field_value').map(([k]) => k);
    expect(created).toEqual([]);
    expect(run.stats.task.unchanged).toBe(6);
    expect(run.stats.comment.unchanged).toBe(4);
  }, 120_000);

  it('a delta run updates a changed task only', async () => {
    const since = new Date(Date.now() - 60_000);
    const rec = loadRecording();
    client = new FixtureClickUpClient(rec);
    const t = client.allTasks().find((x) => x.id === '86fx00004')!;
    t.name = 'Register OAuth app (renamed)';
    t.date_updated = String(Date.now());
    t.priority = { id: '3', priority: 'normal' };
    const before = await fixtureCounts();
    const run = await runToEnd('delta', since);
    expect(run.status).toBe('succeeded');
    expect(run.stats.task).toMatchObject({ seen: 1, updated: 1 });
    const t4 = (await taskByExt('86fx00004'))!;
    expect(t4.name).toBe('Register OAuth app (renamed)');
    expect(t4.priority).toBe(3);
    expect(t4.updatedAt.getTime()).toBe(Number(t.date_updated));
    expect((await taskByExt('86fx00001'))!.name).toBe('Design login page');
    expect(await fixtureCounts()).toEqual(before);
    // only the changed task's comments were fetched
    expect(client.calls.filter((c) => c.endsWith('/comment'))).toEqual(['GET v2/task/86fx00004/comment']);
  }, 120_000);
});
