import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rm, stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { db } from '../../db/client';
import { attachments, comments, tasks } from '../../db/schema';
import { env } from '../../env';
import type { AccessContext } from '../../lib/access';
import { NotFound, Validation } from '../../lib/errors';
import { auth, parse } from '../../lib/http';

/**
 * Attachments live on local disk under DATA_DIR/attachments (simplified from MinIO).
 * The API streams them after the parent object's ACL check.
 */
const root = () => resolve(env.DATA_DIR, 'attachments');
export const storagePath = (key: string) => resolve(root(), key);

const PREVIEWABLE = /^(image\/(png|jpe?g|gif|webp|avif|bmp)|application\/pdf|text\/plain|video\/(mp4|webm)|audio\/)/;
const BLOCKED_EXT = /\.(exe|bat|cmd|com|scr|msi|ps1|vbs|js|jar)$/i;

/** Store a stream as an attachment file; returns storage key, size and sha256. */
export async function storeFile(source: NodeJS.ReadableStream): Promise<{ storageKey: string; sizeBytes: number; sha256: string }> {
  const now = new Date();
  const storageKey = `${now.getUTCFullYear()}/${String(now.getUTCMonth() + 1).padStart(2, '0')}/${randomUUID()}`;
  const path = storagePath(storageKey);
  await mkdir(dirname(path), { recursive: true });
  const hash = createHash('sha256');
  let size = 0;
  const counter = new Transform({
    transform(chunk, _enc, cb) {
      hash.update(chunk);
      size += chunk.length;
      cb(null, chunk);
    },
  });
  try {
    await pipeline(source, counter, createWriteStream(path));
  } catch (err) {
    await rm(path, { force: true });
    throw err;
  }
  return { storageKey, sizeBytes: size, sha256: hash.digest('hex') };
}

async function parentLevel(access: AccessContext, a: { taskId: string | null; docId: string | null; commentId: string | null }) {
  if (a.taskId) return access.levelOf('task', a.taskId);
  if (a.docId) return access.levelOf('doc', a.docId);
  if (a.commentId) {
    const [c] = await db.select().from(comments).where(eq(comments.id, a.commentId));
    if (c?.taskId) return access.levelOf('task', c.taskId);
    if (c?.docId) return access.levelOf('doc', c.docId);
  }
  return 'none' as const;
}

export default async function attachmentRoutes(app: FastifyInstance) {
  /** multipart upload: fields taskId | docId | commentId, then one or more files */
  app.post('/', async (req) => {
    const { user, access } = auth(req);
    const parts = req.parts();
    const target: { taskId: string | null; docId: string | null; commentId: string | null } = { taskId: null, docId: null, commentId: null };
    const created = [];
    let checked = false;
    for await (const part of parts) {
      if (part.type === 'field') {
        const v = String(part.value);
        if (part.fieldname in target && /^[0-9a-f-]{36}$/i.test(v)) target[part.fieldname as keyof typeof target] = v;
        continue;
      }
      if (!checked) {
        if (!target.taskId && !target.docId && !target.commentId) throw new Validation('Send taskId, docId or commentId before the file');
        if (target.commentId) {
          const [c] = await db.select().from(comments).where(eq(comments.id, target.commentId));
          if (!c) throw new NotFound();
          // comment attachments need comment level on the parent, and only the author can attach
          const lvl = await parentLevel(access, target);
          if (lvl === 'none') throw new NotFound();
          if (c.authorId !== user.id) throw new Validation('You can only attach files to your own comments');
          target.taskId = c.taskId;
          target.docId = c.docId;
        } else {
          await access.require('attach', target.taskId ? 'task' : 'doc', (target.taskId ?? target.docId)!);
        }
        checked = true;
      }
      const filename = (part.filename || 'file').replace(/[\\/\0]/g, '_').slice(0, 200);
      if (BLOCKED_EXT.test(filename)) throw new Validation(`${filename}: executable files are not allowed`);
      const stored = await storeFile(part.file);
      if (part.file.truncated) {
        await rm(storagePath(stored.storageKey), { force: true });
        throw new Validation(`${filename} is larger than ${env.MAX_UPLOAD_MB} MB`);
      }
      const [a] = await db.insert(attachments).values({
        ...target, uploaderId: user.id, filename, contentType: part.mimetype || 'application/octet-stream', ...stored,
      }).returning();
      created.push(a);
    }
    if (target.taskId) await db.update(tasks).set({ updatedAt: new Date() }).where(eq(tasks.id, target.taskId));
    return created;
  });

  app.get<{ Params: { id: string } }>('/:id/:name?', async (req, reply) => {
    const { access } = auth(req);
    const { download } = parse(z.object({ download: z.string().optional() }), req.query);
    const [a] = await db.select().from(attachments).where(eq(attachments.id, req.params.id));
    if (!a || a.deletedAt || (await parentLevel(access, a)) === 'none') throw new NotFound();
    const path = storagePath(a.storageKey);
    const st = await stat(path).catch(() => null);
    if (!st) throw new NotFound('File is missing from storage');
    const inline = !download && PREVIEWABLE.test(a.contentType);
    reply
      .header('content-type', inline ? a.contentType : 'application/octet-stream')
      .header('content-length', st.size)
      .header('content-disposition', `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(a.filename)}`)
      .header('x-content-type-options', 'nosniff')
      .header('cache-control', 'private, max-age=3600')
      .header('content-security-policy', "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox");
    return reply.send(createReadStream(path));
  });

  app.delete<{ Params: { id: string } }>('/:id', async (req) => {
    const { user, access } = auth(req);
    const [a] = await db.select().from(attachments).where(and(eq(attachments.id, req.params.id)));
    if (!a || a.deletedAt) throw new NotFound();
    const level = await parentLevel(access, a);
    if (level === 'none') throw new NotFound();
    if (a.uploaderId !== user.id && level !== 'full' && level !== 'edit') throw new Validation('You cannot delete this file');
    await db.update(attachments).set({ deletedAt: new Date() }).where(eq(attachments.id, a.id));
    await rm(storagePath(a.storageKey), { force: true });
    return { ok: true };
  });
}
