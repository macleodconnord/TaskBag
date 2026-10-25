import { extractMentions, richTextToPlain } from '@app/shared';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import type { Tx } from '../../db/client';
import { attachments, comments, docRevisions, docs, folders, lists, notifications, spaces } from '../../db/schema';
import { scopeIdOf } from '../../lib/access';
import { dropScopesFor, subtree } from '../../lib/acl';
import { NotFound } from '../../lib/errors';
import { emit } from '../../lib/events';

export type DocRow = typeof docs.$inferSelect;
export type ContainerType = 'space' | 'folder' | 'list';

/** Revisions are snapshotted at most once per this interval per doc. */
export const REVISION_INTERVAL_MS = 5 * 60_000;

export async function containerExists(tx: Tx, type: ContainerType, id: string) {
  const t = type === 'space' ? spaces : type === 'folder' ? folders : lists;
  const [row] = await tx.select({ id: t.id }).from(t).where(eq(t.id, id));
  return !!row;
}

export async function containerScope(tx: Tx, type: ContainerType, id: string) {
  const s = await scopeIdOf(type, id, tx);
  if (!s) throw new NotFound('Container not found');
  return s;
}

/** Names-only breadcrumb for a container (space › folder › list). */
export async function containerPath(tx: Tx, type: ContainerType, id: string) {
  const out: Array<{ type: ContainerType; id: string; name: string }> = [];
  if (type === 'list') {
    const [l] = await tx.select().from(lists).where(eq(lists.id, id));
    if (!l) return out;
    const [s] = await tx.select().from(spaces).where(eq(spaces.id, l.spaceId));
    if (s) out.push({ type: 'space', id: s.id, name: s.name });
    if (l.folderId) {
      const [f] = await tx.select().from(folders).where(eq(folders.id, l.folderId));
      if (f) out.push({ type: 'folder', id: f.id, name: f.name });
    }
    out.push({ type: 'list', id: l.id, name: l.name });
  } else if (type === 'folder') {
    const [f] = await tx.select().from(folders).where(eq(folders.id, id));
    if (!f) return out;
    const [s] = await tx.select().from(spaces).where(eq(spaces.id, f.spaceId));
    if (s) out.push({ type: 'space', id: s.id, name: s.name });
    out.push({ type: 'folder', id: f.id, name: f.name });
  } else {
    const [s] = await tx.select().from(spaces).where(eq(spaces.id, id));
    if (s) out.push({ type: 'space', id: s.id, name: s.name });
  }
  return out;
}

/** Ancestor docs, root first. */
export async function ancestors(tx: Tx, doc: DocRow) {
  const rows = await tx.execute<{ id: string; title: string; acl_scope_id: string; depth: number }>(sql`
    with recursive up as (
      select id, parent_doc_id, title, acl_scope_id, 0 as depth from docs where id = ${doc.parentDocId}
      union all
      select d.id, d.parent_doc_id, d.title, d.acl_scope_id, up.depth + 1 from docs d join up on d.id = up.parent_doc_id where up.depth < 50
    ) select id, title, acl_scope_id, depth from up order by depth desc`);
  return doc.parentDocId ? rows.map((r) => ({ id: r.id, title: r.title, aclScopeId: r.acl_scope_id })) : [];
}

/** Snapshot the doc's current state unless one was taken within REVISION_INTERVAL_MS (or `force`). */
export async function maybeSnapshot(tx: Tx, doc: DocRow, authorId: string | null, force = false) {
  if (!force) {
    if (!doc.content && !doc.contentText) return false; // nothing worth keeping yet
    const [last] = await tx.select({ at: docRevisions.createdAt }).from(docRevisions)
      .where(eq(docRevisions.docId, doc.id)).orderBy(desc(docRevisions.createdAt)).limit(1);
    if (last && Date.now() - last.at.getTime() < REVISION_INTERVAL_MS) return false;
  }
  await tx.insert(docRevisions).values({ docId: doc.id, title: doc.title, content: doc.content, authorId: doc.updatedBy ?? authorId });
  return true;
}

/** Write title/content, snapshot the previous state (throttled), and emit doc.mentioned for new mentions only. */
export async function writeDoc(tx: Tx, doc: DocRow, patch: { title?: string; content?: unknown }, actorId: string, opts: { forceSnapshot?: boolean } = {}) {
  const set: Partial<typeof docs.$inferInsert> = { updatedBy: actorId };
  const contentChanged = patch.content !== undefined && JSON.stringify(patch.content) !== JSON.stringify(doc.content);
  const titleChanged = patch.title !== undefined && patch.title !== doc.title;
  if (!contentChanged && !titleChanged) return { doc, newMentions: [] as string[] };
  await maybeSnapshot(tx, doc, actorId, opts.forceSnapshot);
  if (titleChanged) set.title = patch.title;
  let newMentions: string[] = [];
  if (contentChanged) {
    set.content = patch.content ?? null;
    set.contentText = patch.content ? richTextToPlain(patch.content) : '';
    const before = new Set(extractMentions(doc.content));
    newMentions = extractMentions(patch.content).filter((u) => !before.has(u) && u !== actorId);
  }
  const [updated] = await tx.update(docs).set(set).where(eq(docs.id, doc.id)).returning();
  if (newMentions.length) emit('doc.mentioned', { docId: doc.id, actorId, mentionedUserIds: newMentions });
  return { doc: updated, newMentions };
}

/** Hard delete a doc and its descendants (with their comments, revisions, attachments rows, own scopes). */
export async function deleteDocTree(tx: Tx, id: string) {
  const ids = (await subtree(tx, 'doc', id)).docs;
  if (!ids.length) return [];
  await dropScopesFor(tx, ids);
  await tx.delete(comments).where(inArray(comments.docId, ids));
  await tx.update(attachments).set({ deletedAt: new Date() }).where(and(inArray(attachments.docId, ids)));
  await tx.delete(notifications).where(inArray(notifications.docId, ids));
  await tx.delete(docs).where(inArray(docs.id, ids));
  return ids;
}
