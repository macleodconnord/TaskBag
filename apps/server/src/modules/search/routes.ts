import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { db } from '../../db/client';
import { comments, docs, tasks } from '../../db/schema';
import { auth, parse } from '../../lib/http';

/** Unified search over tasks, comments and docs. Every branch is ACL-filtered before ranking. */
export default async function searchRoutes(app: FastifyInstance) {
  app.get('/', async (req) => {
    const { access } = auth(req);
    const { q, limit } = parse(z.object({ q: z.string().trim().min(1).max(200), limit: z.coerce.number().int().min(1).max(50).default(20) }), req.query);
    const terms = q.split(/\s+/).filter(Boolean).map((t) => t.replace(/[^\p{L}\p{N}_-]/gu, '')).filter(Boolean);
    const tsq = terms.length ? sql`to_tsquery('simple', ${terms.map((t) => `${t}:*`).join(' & ')})` : sql`to_tsquery('simple', '')`;
    const like = `%${q}%`;

    const taskVisible = await access.filter(tasks.aclScopeId);
    const taskRank = sql<number>`ts_rank_cd(${tasks.search}, ${tsq}) + case when ${tasks.key} ilike ${q} then 10 when ${tasks.name} ilike ${like} then 1 else 0 end`;
    const [taskHits, commentHits, docHits] = await Promise.all([
      db.select({
        id: tasks.id, key: tasks.key, name: tasks.name, listId: tasks.listId, completedAt: tasks.completedAt,
        rank: taskRank,
      }).from(tasks)
        .where(and(taskVisible, isNull(tasks.deletedAt), sql`(${tasks.search} @@ ${tsq} or ${tasks.name} ilike ${like} or ${tasks.key} ilike ${q})`))
        .orderBy(desc(taskRank), desc(tasks.updatedAt)).limit(limit),
      db.select({
        id: comments.id, taskId: comments.taskId, docId: comments.docId,
        snippet: sql<string>`ts_headline('simple', ${comments.bodyText}, ${tsq}, 'MaxWords=20, MinWords=8, StartSel=«, StopSel=»')`,
        taskKey: tasks.key, taskName: tasks.name,
      }).from(comments).innerJoin(tasks, eq(tasks.id, comments.taskId))
        .where(and(taskVisible, isNull(tasks.deletedAt), isNull(comments.deletedAt), sql`${comments.search} @@ ${tsq}`))
        .orderBy(desc(sql`ts_rank_cd(${comments.search}, ${tsq})`)).limit(limit),
      db.select({
        id: docs.id, title: docs.title,
        snippet: sql<string>`ts_headline('simple', ${docs.contentText}, ${tsq}, 'MaxWords=20, MinWords=8, StartSel=«, StopSel=»')`,
      }).from(docs)
        .where(and(await access.filter(docs.aclScopeId), isNull(docs.archivedAt), sql`(${docs.search} @@ ${tsq} or ${docs.title} ilike ${like})`))
        .orderBy(desc(sql`ts_rank_cd(${docs.search}, ${tsq})`)).limit(limit),
    ]);
    return { tasks: taskHits, comments: commentHits, docs: docHits };
  });
}
