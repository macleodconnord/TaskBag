import { createHash } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { and, asc, eq, isNotNull } from 'drizzle-orm';
import { db } from '../../../db/client';
import { attachments, comments, externalIds, tasks } from '../../../db/schema';
import { addComment } from '../../comments/routes';
import { storagePath, storeFile } from '../../attachments/routes';
import type { CuComment } from '../clickup/schemas';
import { SOURCE, type ImportContext } from '../context';
import { commentToRichText, type RichDoc } from '../markdown';

const MIME: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', pdf: 'application/pdf',
  txt: 'text/plain', csv: 'text/csv', md: 'text/markdown', json: 'application/json', zip: 'application/zip', mp4: 'video/mp4',
  doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};

export const sourceExternal = (commentId: string) => `${SOURCE}:${commentId}`;

/** Tasks whose comments/attachments this run should import: every task touched by the run (dry: seen). */
async function taskQueue(ctx: ImportContext): Promise<string[]> {
  if (ctx.dry) return ctx.dryTaskIds;
  const rows = await db.select({ e: externalIds.externalId }).from(externalIds)
    .where(and(eq(externalIds.source, SOURCE), eq(externalIds.entity, 'task'), eq(externalIds.importRunId, ctx.run.id)))
    .orderBy(asc(externalIds.externalId));
  return rows.map((r) => r.e);
}

export interface AttachmentSource { id: string; title: string; url: string; size?: number | null; mimetype?: string | null; extension?: string | null; date?: number | null; userId?: string | null }

/** Download one ClickUp file into attachment storage (sha256 recorded); idempotent via external_ids. */
export async function importAttachment(ctx: ImportContext, a: AttachmentSource, taskId: string | null, commentId: string | null) {
  ctx.stat('attachment', 'seen');
  if (await ctx.lookup('attachment', a.id)) {
    ctx.stat('attachment', 'unchanged');
    return;
  }
  if (ctx.dry || !ctx.options.downloadAttachments) {
    ctx.stat('attachment', ctx.dry ? 'created' : 'skipped');
    if (a.size) ctx.stat('attachment_bytes', 'seen', a.size);
    return;
  }
  try {
    const dl = await ctx.api.download(a.url);
    const stored = await storeFile(dl.stream);
    if (a.size && a.size !== stored.sizeBytes) {
      ctx.issue('warn', 'attachment', a.id, `"${a.title}": ClickUp reports ${a.size} bytes, downloaded ${stored.sizeBytes}`);
    }
    const ext = (a.extension || a.title.split('.').pop() || '').toLowerCase();
    const filename = (a.title || `attachment${ext ? `.${ext}` : ''}`).replace(/[\\/\0]/g, '_').slice(0, 200);
    const contentType = a.mimetype || MIME[ext] || dl.contentType?.split(';')[0] || 'application/octet-stream';
    try {
      await db.transaction(async (tx) => {
        const [row] = await tx.insert(attachments).values({
          taskId, commentId, uploaderId: ctx.author(a.userId), filename, contentType, ...stored,
          ...(a.date ? { createdAt: new Date(a.date) } : {}),
        }).returning({ id: attachments.id });
        await ctx.link(tx, 'attachment', a.id, row.id, stored.sha256);
      });
    } catch (err) {
      await rm(storagePath(stored.storageKey), { force: true });
      throw err;
    }
    ctx.stat('attachment', 'created');
    ctx.stat('attachment_bytes', 'created', stored.sizeBytes);
  } catch (err) {
    ctx.stat('attachment', 'failed');
    ctx.issue('error', 'attachment', a.id, `"${a.title}" could not be imported: ${(err as Error).message}`);
  }
}

async function importComment(ctx: ImportContext, c: CuComment, taskId: string | null, parentId: string | null, known: Map<string, string>): Promise<string | null> {
  ctx.stat('comment', 'seen');
  if (c.reactions?.length) ctx.dropped('comment_reactions', c.reactions.length);
  if (c.assignee) ctx.dropped('assigned_comments');
  const existing = known.get(sourceExternal(c.id));
  if (existing) {
    ctx.stat('comment', 'unchanged');
    return existing;
  }
  const conv = commentToRichText(c.comment, c.comment_text, (id) => ctx.users.get(id) ?? null);
  if (ctx.dry || !taskId) {
    ctx.stat('comment', 'created');
    for (const a of conv.attachments) await importAttachment(ctx, { id: a.id ?? `url:${hash(a.url)}`, title: a.title, url: a.url }, null, null);
    return null;
  }
  const mappedAuthor = c.user ? ctx.users.get(String(c.user.id)) : null;
  let body: RichDoc = conv.doc;
  if (!mappedAuthor && c.user) {
    // keep who wrote it when the author isn't mapped
    body = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: `${c.user.username ?? c.user.email ?? 'ClickUp user'} wrote:`, marks: [{ type: 'italic' }] }] }, ...conv.doc.content] };
  }
  const row = await addComment({ kind: 'task', id: taskId }, ctx.author(c.user?.id), body, parentId, {
    sourceExternal: sourceExternal(c.id), createdAt: c.date ? new Date(c.date) : undefined, silent: true,
  });
  await ctx.link(db, 'comment', c.id, row.id, null);
  known.set(sourceExternal(c.id), row.id);
  ctx.stat('comment', 'created');
  for (const a of conv.attachments) {
    await importAttachment(ctx, { id: a.id ?? `url:${hash(a.url)}`, title: a.title, url: a.url, userId: c.user?.id ?? null, date: c.date }, taskId, row.id);
  }
  return row.id;
}

const hash = (s: string) => createHash('sha1').update(s).digest('hex').slice(0, 16);

/** Stage 6: threaded comments (original author + time) and task attachments, per task, resumable. */
export async function runActivity(ctx: ImportContext) {
  if (!ctx.options.includeActivity) {
    ctx.issue('info', 'comment', null, 'Comments and attachments were skipped for this run (option)');
    return;
  }
  const queue = await taskQueue(ctx);
  for (let i = ctx.cursor.pos!.activity ?? 0; i < queue.length; i++) {
    const ext = queue[i];
    const taskId = ctx.dry ? null : await ctx.idOf('task', ext);
    try {
      const [t] = taskId ? await db.select({ deletedAt: tasks.deletedAt, updatedAt: tasks.updatedAt }).from(tasks).where(eq(tasks.id, taskId)) : [];
      const createdBefore = ctx.stats.comment?.created ?? 0;
      if (ctx.dry || (t && !t.deletedAt)) {
        const known = new Map<string, string>();
        if (taskId) {
          const rows = await db.select({ id: comments.id, s: comments.sourceExternal }).from(comments).where(and(eq(comments.taskId, taskId), isNotNull(comments.sourceExternal)));
          for (const r of rows) known.set(r.s!, r.id);
        }
        for (const c of await ctx.api.getComments(ext)) {
          const id = await importComment(ctx, c, taskId, null, known);
          if (c.reply_count > 0) {
            for (const r of await ctx.api.getReplies(c.id)) await importComment(ctx, r, taskId, id, known);
          }
        }
        const detail = await ctx.api.getTask(ext);
        for (const a of detail.attachments ?? []) {
          await importAttachment(ctx, {
            id: a.id, title: a.title ?? 'attachment', url: a.url, size: a.size, mimetype: a.mimetype, extension: a.extension,
            date: a.date, userId: a.user?.id ?? null,
          }, taskId, null);
        }
        // adding comments bumps updated_at; keep ClickUp's last-updated time
        if (taskId && t && (ctx.stats.comment?.created ?? 0) > createdBefore) {
          await db.update(tasks).set({ updatedAt: t.updatedAt }).where(eq(tasks.id, taskId));
        }
      }
    } catch (err) {
      ctx.issue('error', 'comment', ext, `Comments/attachments of task ${ext} failed: ${(err as Error).message}`);
    }
    ctx.cursor.pos!.activity = i + 1;
    ctx.progress(i + 1, queue.length, `task ${ext}`);
    await ctx.checkpoint();
  }
}
