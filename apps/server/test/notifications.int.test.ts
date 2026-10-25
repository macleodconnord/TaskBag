/**
 * Notifications & doc mentions against the real dev Postgres — permissions.md §6.
 * Fixture (own data, unique names, removed afterwards): private Space S (author full, seer view) → List L → Task T.
 * `outsider` is a workspace member who can't see S. They must get no notification and no email.
 */
import './load-env';
import { and, eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db, sqlClient } from '../src/db/client';
import { aclScopes, docs, emailOutbox, lists, notifications, spaces, statusSets, tasks, users, workspaces } from '../src/db/schema';
import { AccessContext, bumpAcl } from '../src/lib/access';
import { makePrivate, rootScopeId, setSharing } from '../src/lib/acl';
import { runTx } from '../src/lib/tx';
import { addComment } from '../src/modules/comments/routes';
import { writeDoc } from '../src/modules/docs/service';
import { createStatusSet } from '../src/modules/hierarchy/service';
import { smtpSettings } from '../src/modules/notifications/email';
import { renderNotifications } from '../src/modules/notifications/render';
import { dueState, notifyAdmins, registerFanout, scanDueDates } from '../src/modules/notifications/service';
import { createTask, updateTask, type TaskRow } from '../src/modules/tasks/service';

const tag = `nt${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`;
let spaceId: string;
let listId: string;
let T: TaskRow;
let docId: string;
let author: AccessContext;
let seer: AccessContext;
let outsider: AccessContext;
const userIds: string[] = [];
const emails = new Map<string, string>();

async function mkUser(name: string) {
  const email = `${name}-${tag}@test.local`;
  const [u] = await db.insert(users).values({ email, displayName: `${name} ${tag}`, role: 'member' }).returning();
  userIds.push(u.id);
  emails.set(u.id, email);
  return new AccessContext({ id: u.id, role: 'member', isActive: true });
}

const mentionDoc = (...ids: string[]) => ({
  type: 'doc' as const,
  content: [{ type: 'paragraph', content: [{ type: 'text', text: 'hey ' }, ...ids.map((id) => ({ type: 'mention', attrs: { id, label: id.slice(0, 4) } }))] }],
});

const inbox = (uid: string) => db.select().from(notifications).where(eq(notifications.userId, uid));
const outbox = (uid: string) => db.select().from(emailOutbox).where(eq(emailOutbox.toAddress, emails.get(uid)!));

/** Events are delivered after commit, asynchronously: wait until `check` passes (or time out). */
async function eventually(check: () => Promise<boolean>, ms = 5_000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
}
const settle = () => new Promise((r) => setTimeout(r, 600));

beforeAll(async () => {
  registerFanout();
  author = await mkUser('author');
  seer = await mkUser('seer');
  outsider = await mkUser('outsider');
  await runTx(async (tx) => {
    const [ws] = await tx.select().from(workspaces).limit(1);
    const root = await rootScopeId(tx);
    const [s] = await tx.insert(spaces).values({ workspaceId: ws.id, name: `S ${tag}`, keyPrefix: `N${tag.slice(-8).toUpperCase().replace(/[^A-Z0-9]/g, 'X')}`, aclScopeId: root }).returning();
    spaceId = s.id;
    await tx.update(spaces).set({ statusSetId: await createStatusSet(tx, 'space', s.id) }).where(eq(spaces.id, s.id));
    const [l] = await tx.insert(lists).values({ spaceId: s.id, name: `L ${tag}`, aclScopeId: root }).returning();
    listId = l.id;
    await setSharing(tx, 'space', s.id, 'override', [
      { principalType: 'user', principalId: author.user.id, level: 'full' },
      { principalType: 'user', principalId: seer.user.id, level: 'view' },
    ], author.user.id);
  });
  bumpAcl();
  await runTx(async (tx) => {
    T = await createTask(tx, { listId, name: `Task ${tag}`, assigneeIds: [seer.user.id] }, { actorId: author.user.id, silent: true });
    const [ws] = await tx.select().from(workspaces).limit(1);
    const [d] = await tx.insert(docs).values({
      workspaceId: ws.id, containerType: 'space', containerId: spaceId, title: `Doc ${tag}`, aclScopeId: T.aclScopeId, createdBy: author.user.id,
    }).returning();
    docId = d.id;
  });
  expect(await outsider.levelOf('task', T.id)).toBe('none');
  expect(await seer.levelOf('task', T.id)).toBe('view');
}, 30_000);

afterAll(async () => {
  if (userIds.length) {
    await db.delete(emailOutbox).where(inArray(emailOutbox.userId, userIds));
    await db.delete(notifications).where(inArray(notifications.userId, userIds));
  }
  if (docId) await db.delete(docs).where(eq(docs.id, docId));
  if (spaceId) {
    await db.delete(aclScopes).where(inArray(aclScopes.objectId, [spaceId, listId, T?.id, docId].filter(Boolean) as string[]));
    await db.delete(spaces).where(eq(spaces.id, spaceId));
    await db.delete(statusSets).where(eq(statusSets.ownerId, spaceId));
  }
  if (userIds.length) await db.delete(users).where(inArray(users.id, userIds));
  bumpAcl();
  await sqlClient.end();
});

describe('notification fan-out respects the recipient ACL (permissions.md §6)', () => {
  it('a comment mentioning someone who cannot see the task: no notification, no email for them', async () => {
    const c = await addComment({ kind: 'task', id: T.id }, author.user.id, mentionDoc(seer.user.id, outsider.user.id), null);
    await eventually(async () => (await inbox(seer.user.id)).some((n) => n.commentId === c.id));
    await settle();

    const seerRows = (await inbox(seer.user.id)).filter((n) => n.commentId === c.id);
    expect(seerRows).toHaveLength(1); // mentioned wins over "commented" (seer is also the assignee)
    expect(seerRows[0].eventType).toBe('mentioned');

    expect(await inbox(outsider.user.id)).toHaveLength(0);
    expect(await outbox(outsider.user.id)).toHaveLength(0);
    // with SMTP configured (dev seeds Mailpit), the seer gets an instant email for the mention
    if (await smtpSettings()) expect((await outbox(seer.user.id)).some((m) => m.subject.includes('mentioned you'))).toBe(true);
    // the actor is never notified
    expect(await inbox(author.user.id)).toHaveLength(0);
  });

  it('a doc mention of someone who cannot see the doc: no notification, no email; only new mentions notify', async () => {
    await runTx(async (tx) => {
      const [d] = await tx.select().from(docs).where(eq(docs.id, docId));
      await writeDoc(tx, d, { content: mentionDoc(seer.user.id, outsider.user.id) }, author.user.id);
    });
    await eventually(async () => (await inbox(seer.user.id)).some((n) => n.docId === docId));
    await settle();
    expect((await inbox(seer.user.id)).filter((n) => n.docId === docId)).toHaveLength(1);
    expect(await inbox(outsider.user.id)).toHaveLength(0);
    expect(await outbox(outsider.user.id)).toHaveLength(0);

    // re-saving with the same mentions (plus text) does not notify again
    await runTx(async (tx) => {
      const [d] = await tx.select().from(docs).where(eq(docs.id, docId));
      const c = mentionDoc(seer.user.id, outsider.user.id);
      c.content.push({ type: 'paragraph', content: [{ type: 'text', text: 'more' }] });
      await writeDoc(tx, d, { content: c }, author.user.id);
    });
    await settle();
    expect((await inbox(seer.user.id)).filter((n) => n.docId === docId)).toHaveLength(1);
  });

  it('status change notifies assignees + creator but not the actor', async () => {
    const [st] = await db.select({ id: tasks.statusId }).from(tasks).where(eq(tasks.id, T.id));
    const { statusesForList } = await import('../src/modules/hierarchy/service');
    const other = (await statusesForList(db, listId)).find((s) => s.id !== st.id)!;
    await runTx(async (tx) => {
      const [cur] = await tx.select().from(tasks).where(eq(tasks.id, T.id));
      await updateTask(tx, cur, { statusId: other.id }, { actorId: author.user.id });
    });
    await eventually(async () => (await inbox(seer.user.id)).some((n) => n.eventType === 'status_changed'));
    expect((await inbox(seer.user.id)).filter((n) => n.eventType === 'status_changed')).toHaveLength(1);
    expect((await inbox(author.user.id)).filter((n) => n.eventType === 'status_changed')).toHaveLength(0);
    // restore
    await runTx(async (tx) => {
      const [cur] = await tx.select().from(tasks).where(eq(tasks.id, T.id));
      await updateTask(tx, cur, { statusId: st.id }, { actorId: author.user.id, silent: true });
    });
  });

  it('inbox items render redacted once access is revoked', async () => {
    const rows = await inbox(seer.user.id);
    expect((await renderNotifications(rows, seer)).every((r) => !r.redacted)).toBe(true);
    await runTx((tx) => makePrivate(tx, 'space', spaceId, author.user.id)); // drops seer
    bumpAcl();
    const rendered = await renderNotifications(rows, seer);
    expect(rendered.length).toBeGreaterThan(0);
    for (const r of rendered) {
      expect(r.redacted).toBe(true);
      expect(r.subject).not.toContain(tag);
      expect(r.body).toBeNull();
      expect(r.actor).toBeNull();
    }
    // and a new mention of the now-revoked user produces nothing
    const before = (await inbox(seer.user.id)).length;
    await addComment({ kind: 'task', id: T.id }, author.user.id, mentionDoc(seer.user.id), null);
    await settle();
    expect((await inbox(seer.user.id)).length).toBe(before);
  });
});

describe('due dates', () => {
  it('dueState: date-only uses calendar days in the user timezone; timed uses 24h', () => {
    const now = new Date('2026-03-10T15:00:00Z'); // 10:00 in Chicago
    const noon = (d: string) => new Date(`${d}T17:00:00Z`); // ~noon Chicago
    expect(dueState(noon('2026-03-10'), false, 'America/Chicago', now)).toBe('soon'); // today
    expect(dueState(noon('2026-03-11'), false, 'America/Chicago', now)).toBe('soon'); // tomorrow
    expect(dueState(noon('2026-03-12'), false, 'America/Chicago', now)).toBe('none');
    expect(dueState(noon('2026-03-09'), false, 'America/Chicago', now)).toBe('overdue');
    expect(dueState(new Date('2026-03-11T14:00:00Z'), true, 'UTC', now)).toBe('soon');
    expect(dueState(new Date('2026-03-11T16:00:00Z'), true, 'UTC', now)).toBe('none');
    expect(dueState(new Date('2026-03-10T14:59:00Z'), true, 'UTC', now)).toBe('overdue');
    // the same instant is "today" in Chicago but already yesterday (overdue) in Tokyo
    expect(dueState(new Date('2026-03-10T05:00:00Z'), false, 'America/Chicago', now)).toBe('soon');
    expect(dueState(new Date('2026-03-10T05:00:00Z'), false, 'Asia/Tokyo', now)).toBe('overdue');
  });

  it('scan sends overdue once per due date to assignees who can see the task', async () => {
    await runTx((tx) => setSharing(tx, 'space', spaceId, 'override', [
      { principalType: 'user', principalId: author.user.id, level: 'full' },
      { principalType: 'user', principalId: seer.user.id, level: 'view' },
    ], author.user.id));
    bumpAcl();
    const past = new Date(Date.now() - 3 * 86_400_000);
    await db.update(tasks).set({ dueAt: past, dueHasTime: false, dueNotified: null }).where(eq(tasks.id, T.id));
    await scanDueDates();
    await scanDueDates();
    const rows = (await inbox(seer.user.id)).filter((n) => n.eventType === 'overdue' && n.taskId === T.id);
    expect(rows).toHaveLength(1);
    const [t] = await db.select({ n: tasks.dueNotified }).from(tasks).where(eq(tasks.id, T.id));
    expect(t.n).toBe('overdue');
  });
});

describe('notifyAdmins', () => {
  it('is idempotent per dedupe key', async () => {
    const key = `test-${tag}`;
    const n1 = await notifyAdmins({ title: `Test alert ${tag}`, body: 'b', link: '/admin/integrations', dedupeKey: key });
    const n2 = await notifyAdmins({ title: `Test alert ${tag}`, body: 'b', link: '/admin/integrations', dedupeKey: key });
    expect(n2).toBe(0);
    const rows = await db.select().from(notifications).where(and(eq(notifications.eventType, 'admin_alert')));
    const mine = rows.filter((r) => r.dedupeKey.startsWith(`admin:${key}:`));
    expect(mine).toHaveLength(n1);
    await db.delete(notifications).where(inArray(notifications.id, mine.map((r) => r.id)));
    const { emailOutbox: eo } = await import('../src/db/schema');
    await db.delete(eo).where(eq(eo.subject, `[Admin] Test alert ${tag}`));
  });
});
