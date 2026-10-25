import { createCommentSchema, extractMentions, richTextToPlain, updateCommentSchema } from '@app/shared';
import { and, asc, eq, inArray, isNull } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { db } from '../../db/client';
import { attachments, comments, docs, tasks, users } from '../../db/schema';
import { accessForUser, type AccessContext } from '../../lib/access';
import { Forbidden, NotFound, Validation } from '../../lib/errors';
import { emit } from '../../lib/events';
import { auth, parse } from '../../lib/http';
import { runTx } from '../../lib/tx';

type Target = { kind: 'task' | 'doc'; id: string };

async function listComments(target: Target) {
  const rows = await db
    .select({ c: comments, author: { id: users.id, displayName: users.displayName, avatarUrl: users.avatarUrl, isSystem: users.isSystem } })
    .from(comments).leftJoin(users, eq(users.id, comments.authorId))
    .where(target.kind === 'task' ? eq(comments.taskId, target.id) : eq(comments.docId, target.id))
    .orderBy(asc(comments.createdAt));
  const files = rows.length
    ? await db.select().from(attachments).where(and(inArray(attachments.commentId, rows.map((r) => r.c.id)), isNull(attachments.deletedAt)))
    : [];
  return rows.map(({ c, author }) => {
    const { search: _s, bodyText: _b, ...rest } = c;
    return {
      ...rest,
      body: c.deletedAt ? null : c.body,
      author,
      attachments: files.filter((f) => f.commentId === c.id),
    };
  });
}

/** Create a comment (also used by integrations such as the NinjaOne sync). */
export async function addComment(target: Target, authorId: string, body: unknown, parentId: string | null, opts: { sourceExternal?: string; createdAt?: Date; silent?: boolean } = {}) {
  return runTx(async (tx) => {
    if (parentId) {
      const [p] = await tx.select().from(comments).where(eq(comments.id, parentId));
      if (!p || (target.kind === 'task' ? p.taskId : p.docId) !== target.id) throw new Validation('Reply target not found');
      if (p.parentId) parentId = p.parentId; // one level of threading
    }
    const [c] = await tx.insert(comments).values({
      taskId: target.kind === 'task' ? target.id : null,
      docId: target.kind === 'doc' ? target.id : null,
      parentId,
      authorId,
      body,
      bodyText: richTextToPlain(body),
      sourceExternal: opts.sourceExternal ?? null,
      ...(opts.createdAt ? { createdAt: opts.createdAt } : {}),
    }).returning();
    if (target.kind === 'task') await tx.update(tasks).set({ updatedAt: new Date() }).where(eq(tasks.id, target.id));
    if (!opts.silent) {
      emit('comment.created', {
        commentId: c.id, taskId: c.taskId, docId: c.docId, actorId: authorId,
        mentionedUserIds: extractMentions(body).filter((u) => u !== authorId),
      });
    }
    return c;
  });
}

async function requireTarget(access: AccessContext, target: Target, action: 'view' | 'comment') {
  if (target.kind === 'task') {
    const [t] = await db.select({ id: tasks.id }).from(tasks).where(and(eq(tasks.id, target.id), isNull(tasks.deletedAt)));
    if (!t) throw new NotFound();
  } else {
    const [d] = await db.select({ id: docs.id }).from(docs).where(eq(docs.id, target.id));
    if (!d) throw new NotFound();
  }
  return access.require(action, target.kind, target.id);
}

export default async function commentRoutes(app: FastifyInstance) {
  for (const kind of ['task', 'doc'] as const) {
    app.get<{ Params: { id: string } }>(`/${kind}/:id`, async (req) => {
      const { access } = auth(req);
      await requireTarget(access, { kind, id: req.params.id }, 'view');
      return listComments({ kind, id: req.params.id });
    });
    app.post<{ Params: { id: string } }>(`/${kind}/:id`, async (req) => {
      const { user, access } = auth(req);
      const target = { kind, id: req.params.id };
      await requireTarget(access, target, 'comment');
      const input = parse(createCommentSchema, req.body);
      const c = await addComment(target, user.id, input.body, input.parentId ?? null);
      // mention hint: who was mentioned but can't see this (they won't be notified)
      const cannotSee: string[] = [];
      for (const uid of extractMentions(input.body)) {
        const a = await accessForUser(uid);
        if (!a || (await a.levelOf(kind, target.id)) === 'none') cannotSee.push(uid);
      }
      return { ...c, cannotSee };
    });
  }

  app.patch<{ Params: { id: string } }>('/:id', async (req) => {
    const { user, access } = auth(req);
    const [c] = await db.select().from(comments).where(eq(comments.id, req.params.id));
    if (!c || c.deletedAt) throw new NotFound();
    await requireTarget(access, c.taskId ? { kind: 'task', id: c.taskId } : { kind: 'doc', id: c.docId! }, 'comment');
    if (c.authorId !== user.id) throw new Forbidden('You can only edit your own comments');
    const { body } = parse(updateCommentSchema, req.body);
    const [u] = await db.update(comments).set({ body, bodyText: richTextToPlain(body), editedAt: new Date() }).where(eq(comments.id, c.id)).returning();
    const { search: _s, ...rest } = u;
    return rest;
  });

  app.delete<{ Params: { id: string } }>('/:id', async (req) => {
    const { user, access } = auth(req);
    const [c] = await db.select().from(comments).where(eq(comments.id, req.params.id));
    if (!c || c.deletedAt) throw new NotFound();
    const level = await requireTarget(access, c.taskId ? { kind: 'task', id: c.taskId } : { kind: 'doc', id: c.docId! }, 'view');
    if (c.authorId !== user.id && level !== 'full') throw new Forbidden('You can only delete your own comments');
    await db.update(comments).set({ deletedAt: new Date(), bodyText: '' }).where(eq(comments.id, c.id));
    return { ok: true };
  });
}
