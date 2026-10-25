import { richTextSchema, richTextToPlain } from '@app/shared';
import { and, asc, desc, eq, inArray, isNotNull, isNull, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { db } from '../../db/client';
import { attachments, docRevisions, docs, statuses, users, workspaces } from '../../db/schema';
import { accessForUser } from '../../lib/access';
import { afterMove, makePrivate, parentScopeOf, subtree } from '../../lib/acl';
import { NotFound, Validation } from '../../lib/errors';
import { auth, parse } from '../../lib/http';
import { runTx } from '../../lib/tx';
import { findTask } from '../tasks/service';
import {
  ancestors, containerExists, containerPath, containerScope, deleteDocTree, maybeSnapshot, writeDoc, type ContainerType, type DocRow,
} from './service';

const containerType = z.enum(['space', 'folder', 'list']);
const idParams = z.object({ id: z.string().uuid() });
const listQuery = z.object({ containerType, containerId: z.string().uuid(), archived: z.enum(['true', 'false']).optional() });
const createSchema = z.object({
  containerType: containerType.optional(),
  containerId: z.string().uuid().optional(),
  parentDocId: z.string().uuid().nullish(),
  title: z.string().trim().max(500).optional(),
  content: richTextSchema.nullish(),
  private: z.boolean().optional(),
});
const updateSchema = z.object({
  title: z.string().trim().max(500).optional(),
  content: richTextSchema.nullable().optional(),
  archived: z.boolean().optional(),
});
const moveSchema = z.object({
  parentDocId: z.string().uuid().nullable(),
  containerType: containerType.optional(),
  containerId: z.string().uuid().optional(),
  /** position among the new siblings (0-based); default last */
  index: z.number().int().min(0).optional(),
});

const strip = ({ search: _s, contentText: _t, ...rest }: DocRow) => rest;

async function loadDoc(id: string) {
  const [d] = await db.select().from(docs).where(eq(docs.id, id));
  if (!d) throw new NotFound();
  return d;
}

export default async function docRoutes(app: FastifyInstance) {
  /** Docs in a container that the user can see (flat; the client nests by parentDocId). */
  app.get('/', async (req) => {
    const { access } = auth(req);
    const q = parse(listQuery, req.query);
    const rows = await db.select({
      id: docs.id, parentDocId: docs.parentDocId, title: docs.title, position: docs.position, aclScopeId: docs.aclScopeId,
      archivedAt: docs.archivedAt, updatedAt: docs.updatedAt, createdBy: docs.createdBy,
    }).from(docs).where(and(
      eq(docs.containerType, q.containerType), eq(docs.containerId, q.containerId),
      q.archived === 'true' ? isNotNull(docs.archivedAt) : isNull(docs.archivedAt),
      await access.filter(docs.aclScopeId),
    )).orderBy(asc(docs.position), asc(docs.createdAt));
    const out = [];
    for (const { aclScopeId, ...r } of rows) out.push({ ...r, _perms: { level: await access.levelOfScope(aclScopeId) } });
    return out;
  });

  app.post('/', async (req) => {
    const { user, access } = auth(req);
    const input = parse(createSchema, req.body);
    const doc = await runTx(async (tx) => {
      let ct: ContainerType;
      let cid: string;
      let scope: string;
      if (input.parentDocId) {
        await access.require('create_child', 'doc', input.parentDocId, tx);
        const [p] = await tx.select().from(docs).where(eq(docs.id, input.parentDocId));
        ct = p.containerType;
        cid = p.containerId;
        scope = p.aclScopeId;
      } else {
        if (!input.containerType || !input.containerId) throw new Validation('containerType and containerId are required');
        ct = input.containerType;
        cid = input.containerId;
        if (!(await containerExists(tx, ct, cid))) throw new NotFound('Container not found');
        await access.require('create_child', ct, cid, tx);
        scope = await containerScope(tx, ct, cid);
      }
      const [ws] = await tx.select({ id: workspaces.id }).from(workspaces).limit(1);
      const [{ n }] = await tx.select({ n: sql<number>`coalesce(max(${docs.position}), -1)::int + 1` }).from(docs)
        .where(and(eq(docs.containerType, ct), eq(docs.containerId, cid), input.parentDocId ? eq(docs.parentDocId, input.parentDocId) : isNull(docs.parentDocId)));
      const [d] = await tx.insert(docs).values({
        workspaceId: ws.id, parentDocId: input.parentDocId ?? null, containerType: ct, containerId: cid,
        title: input.title || 'Untitled', content: input.content ?? null,
        contentText: input.content ? richTextToPlain(input.content) : '',
        aclScopeId: scope, position: n, createdBy: user.id, updatedBy: user.id,
      }).returning();
      if (input.private) await makePrivate(tx, 'doc', d.id, user.id);
      return d;
    });
    return strip(doc);
  });

  app.get('/:id', async (req) => {
    const { access } = auth(req);
    const { id } = parse(idParams, req.params);
    const level = await access.require('view', 'doc', id);
    const d = await loadDoc(id);
    const [anc, path, children, files, people] = await Promise.all([
      ancestors(db, d),
      containerPath(db, d.containerType, d.containerId),
      db.select({ id: docs.id, title: docs.title, position: docs.position, updatedAt: docs.updatedAt }).from(docs)
        .where(and(eq(docs.parentDocId, d.id), isNull(docs.archivedAt), await access.filter(docs.aclScopeId)))
        .orderBy(asc(docs.position), asc(docs.createdAt)),
      db.select().from(attachments).where(and(eq(attachments.docId, d.id), isNull(attachments.commentId), isNull(attachments.deletedAt)))
        .orderBy(asc(attachments.createdAt)),
      db.select({ id: users.id, displayName: users.displayName, avatarUrl: users.avatarUrl }).from(users)
        .where(inArray(users.id, [d.createdBy, d.updatedBy].filter((x): x is string => !!x))),
    ]);
    const crumbs = [];
    for (const a of anc) {
      const visible = (await access.levelOfScope(a.aclScopeId)) !== 'none';
      crumbs.push({ id: a.id, title: visible ? a.title : '…', visible });
    }
    const person = (uid: string | null) => people.find((p) => p.id === uid) ?? null;
    return {
      ...strip(d),
      level,
      _perms: { level },
      ancestors: crumbs,
      path,
      children,
      attachments: files,
      creator: person(d.createdBy),
      updater: person(d.updatedBy),
    };
  });

  app.patch('/:id', async (req) => {
    const { user, access } = auth(req);
    const { id } = parse(idParams, req.params);
    const input = parse(updateSchema, req.body);
    await access.require(input.archived !== undefined ? 'delete' : 'edit', 'doc', id);
    if (input.archived !== undefined && (input.title !== undefined || input.content !== undefined)) await access.require('edit', 'doc', id);
    const result = await runTx(async (tx) => {
      const [d] = await tx.select().from(docs).where(eq(docs.id, id)).for('update');
      if (!d) throw new NotFound();
      let { doc, newMentions } = await writeDoc(tx, d, { title: input.title === '' ? 'Untitled' : input.title, content: input.content }, user.id);
      if (input.archived !== undefined) {
        const ids = (await subtree(tx, 'doc', id)).docs;
        await tx.update(docs).set({ archivedAt: input.archived ? new Date() : null }).where(inArray(docs.id, ids));
        [doc] = await tx.select().from(docs).where(eq(docs.id, id));
      }
      return { doc, newMentions };
    });
    // mention hint: who was mentioned but can't see this doc (they won't be notified)
    const cannotSee: string[] = [];
    for (const uid of result.newMentions) {
      const a = await accessForUser(uid);
      if (!a || (await a.levelOf('doc', id)) === 'none') cannotSee.push(uid);
    }
    return { ...strip(result.doc), cannotSee };
  });

  /** Move under another doc / to another container, and/or reorder among siblings. */
  app.post('/:id/move', async (req) => {
    const { access } = auth(req);
    const { id } = parse(idParams, req.params);
    const input = parse(moveSchema, req.body);
    await access.require('edit', 'doc', id);
    await runTx(async (tx) => {
      const [d] = await tx.select().from(docs).where(eq(docs.id, id));
      if (!d) throw new NotFound();
      let ct = d.containerType;
      let cid = d.containerId;
      if (input.parentDocId) {
        const subtreeIds = (await subtree(tx, 'doc', id)).docs;
        if (subtreeIds.includes(input.parentDocId)) throw new Validation('A doc cannot be moved inside itself');
        const [p] = await tx.select().from(docs).where(eq(docs.id, input.parentDocId));
        if (!p) throw new NotFound('Parent doc not found');
        ct = p.containerType;
        cid = p.containerId;
      } else if (input.containerType && input.containerId) {
        ct = input.containerType;
        cid = input.containerId;
        if (!(await containerExists(tx, ct, cid))) throw new NotFound('Container not found');
      }
      const parentChanged = (input.parentDocId ?? null) !== d.parentDocId || ct !== d.containerType || cid !== d.containerId;
      if (parentChanged) {
        if (input.parentDocId) await access.require('create_child', 'doc', input.parentDocId, tx);
        else await access.require('create_child', ct, cid, tx);
        const oldInherited = await parentScopeOf(tx, 'doc', id);
        await tx.update(docs).set({ parentDocId: input.parentDocId ?? null }).where(eq(docs.id, id));
        // the whole subtree follows to the new container
        const ids = (await subtree(tx, 'doc', id)).docs;
        await tx.update(docs).set({ containerType: ct, containerId: cid }).where(inArray(docs.id, ids));
        await afterMove(tx, 'doc', id, oldInherited);
      }
      // renumber siblings with the moved doc at `index`
      const siblings = await tx.select({ id: docs.id }).from(docs).where(and(
        eq(docs.containerType, ct), eq(docs.containerId, cid),
        input.parentDocId ? eq(docs.parentDocId, input.parentDocId) : isNull(docs.parentDocId),
        sql`${docs.id} <> ${id}`,
      )).orderBy(asc(docs.position), asc(docs.createdAt));
      const order = siblings.map((s) => s.id);
      order.splice(Math.min(input.index ?? order.length, order.length), 0, id);
      for (const [i, sid] of order.entries()) await tx.update(docs).set({ position: i }).where(eq(docs.id, sid));
    });
    return { ok: true };
  });

  app.delete('/:id', async (req) => {
    const { access } = auth(req);
    const { id } = parse(idParams, req.params);
    await access.require('delete', 'doc', id);
    const ids = await runTx((tx) => deleteDocTree(tx, id));
    return { ok: true, deleted: ids.length };
  });

  // ── revisions ──
  app.get('/:id/revisions', async (req) => {
    const { access } = auth(req);
    const { id } = parse(idParams, req.params);
    await access.require('view', 'doc', id);
    return db.select({
      id: docRevisions.id, title: docRevisions.title, createdAt: docRevisions.createdAt,
      author: { id: users.id, displayName: users.displayName, avatarUrl: users.avatarUrl },
    }).from(docRevisions).leftJoin(users, eq(users.id, docRevisions.authorId))
      .where(eq(docRevisions.docId, id)).orderBy(desc(docRevisions.createdAt)).limit(200);
  });

  app.get('/:id/revisions/:revId', async (req) => {
    const { access } = auth(req);
    const { id, revId } = parse(z.object({ id: z.string().uuid(), revId: z.string().uuid() }), req.params);
    await access.require('view', 'doc', id);
    const [r] = await db.select().from(docRevisions).where(and(eq(docRevisions.id, revId), eq(docRevisions.docId, id)));
    if (!r) throw new NotFound();
    return r;
  });

  app.post('/:id/revisions/:revId/restore', async (req) => {
    const { user, access } = auth(req);
    const { id, revId } = parse(z.object({ id: z.string().uuid(), revId: z.string().uuid() }), req.params);
    await access.require('edit', 'doc', id);
    const doc = await runTx(async (tx) => {
      const [r] = await tx.select().from(docRevisions).where(and(eq(docRevisions.id, revId), eq(docRevisions.docId, id)));
      if (!r) throw new NotFound();
      const [d] = await tx.select().from(docs).where(eq(docs.id, id)).for('update');
      // always keep the state we're replacing, so a restore can be undone
      await maybeSnapshot(tx, d, user.id, true);
      return (await writeDoc(tx, { ...d, updatedBy: user.id }, { title: r.title, content: r.content ?? null }, user.id, { forceSnapshot: false })).doc;
    });
    return strip(doc);
  });

  /**
   * Task embeds: resolve task refs (keys, short ids or uuids) found in the doc, returning only
   * tasks the viewer can see — re-checked on every render.
   */
  app.get('/:id/task-refs', async (req) => {
    const { access } = auth(req);
    const { id } = parse(idParams, req.params);
    const { ids } = parse(z.object({ ids: z.string().default('') }), req.query);
    await access.require('view', 'doc', id);
    const refs = [...new Set(ids.split(',').map((s) => s.trim()).filter(Boolean))].slice(0, 100);
    const out = [];
    for (const ref of refs) {
      const t = await findTask(db, ref);
      if (!t || (await access.levelOfScope(t.aclScopeId)) === 'none') continue;
      const [st] = await db.select().from(statuses).where(eq(statuses.id, t.statusId));
      out.push({
        ref, id: t.id, key: t.key, name: t.name, completedAt: t.completedAt, dueAt: t.dueAt,
        status: st ? { name: st.name, color: st.color, group: st.group } : null,
      });
    }
    return out;
  });

  /** Quick check: which of these users can't see the doc (for the editor's mention hint). */
  app.get('/:id/mention-check', async (req) => {
    const { access } = auth(req);
    const { id } = parse(idParams, req.params);
    const { userIds } = parse(z.object({ userIds: z.string().default('') }), req.query);
    await access.require('view', 'doc', id);
    const cannotSee: string[] = [];
    for (const uid of userIds.split(',').filter((u) => /^[0-9a-f-]{36}$/i.test(u)).slice(0, 50)) {
      const a = await accessForUser(uid);
      if (!a || (await a.levelOf('doc', id)) === 'none') cannotSee.push(uid);
    }
    return { cannotSee };
  });

}
