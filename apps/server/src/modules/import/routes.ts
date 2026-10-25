import { and, asc, desc, eq, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { db } from '../../db/client';
import { importIssues, importRuns, importUserMappings, users } from '../../db/schema';
import { NotFound, Validation } from '../../lib/errors';
import { auth, parse, type Req } from '../../lib/http';
import { clickupCredentials, createClickUpClient } from './clickup/client';
import { buildReport, reportCsv, runView } from './report';
import { activeRun, cancelRun, createRun, defaultSince, launch, lockIsFree, openRun, pauseRun, resumeRun, revalidate } from './runner';
import { refreshUserMappings, resolveUserMapping } from './stages/users';

const admin = (req: Req) => {
  const a = auth(req);
  a.access.requireAdmin();
  return a;
};

const optionsSchema = z.object({
  includeArchived: z.boolean().optional(),
  includeActivity: z.boolean().optional(),
  downloadAttachments: z.boolean().optional(),
  includeDocs: z.boolean().optional(),
  includeViews: z.boolean().optional(),
  includePermissions: z.boolean().optional(),
}).default({});

async function loadRun(id: string) {
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw new NotFound();
  const [run] = await db.select().from(importRuns).where(eq(importRuns.id, id));
  if (!run) throw new NotFound();
  return run;
}

/** /api/import — ClickUp importer (admins only). */
export default async function importRoutes(app: FastifyInstance) {
  app.get('/status', async (req) => {
    admin(req);
    const c = await clickupCredentials();
    const open = await openRun();
    return {
      credentials: { configured: !!(c.token && c.teamId), source: c.source, enabled: c.enabled, teamId: c.teamId },
      openRun: open ? await runView(open) : null,
      executing: activeRun()?.runId ?? null,
      lockFree: await lockIsFree(),
      defaultSince: await defaultSince(),
    };
  });

  /** Connection test: workspace name, member count and the rate-limit headers ClickUp returned. */
  app.post('/test', async (req) => {
    admin(req);
    try {
      const api = await createClickUpClient();
      const ws = await api.getWorkspace();
      return { ok: true, workspace: ws.name, members: ws.members.length, rateLimit: api.stats() };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  });

  app.get('/runs', async (req) => {
    admin(req);
    const rows = await db.select().from(importRuns).orderBy(desc(importRuns.createdAt)).limit(25);
    return Promise.all(rows.map(runView));
  });

  app.get<{ Params: { id: string } }>('/runs/:id', async (req) => {
    admin(req);
    return runView(await loadRun(req.params.id));
  });

  app.post('/runs', async (req) => {
    const { user } = admin(req);
    const input = parse(z.object({
      mode: z.enum(['dry_run', 'full', 'delta']),
      options: optionsSchema,
      since: z.string().datetime({ offset: true }).nullable().optional(),
    }), req.body);
    try {
      await createClickUpClient(); // fail fast when credentials are missing
    } catch (err) {
      throw new Validation((err as Error).message);
    }
    const run = await createRun({ mode: input.mode, startedBy: user.id, options: input.options, since: input.since ? new Date(input.since) : null });
    void launch(run.id);
    return runView(run);
  });

  for (const action of ['pause', 'resume', 'cancel', 'validate'] as const) {
    app.post<{ Params: { id: string } }>(`/runs/:id/${action}`, async (req) => {
      admin(req);
      const run = await loadRun(req.params.id);
      if (action === 'pause') await pauseRun(run.id);
      else if (action === 'resume') await resumeRun(run.id);
      else if (action === 'cancel') await cancelRun(run.id);
      else void revalidate(run.id);
      return runView((await loadRun(run.id)));
    });
  }

  app.get<{ Params: { id: string } }>('/runs/:id/issues', async (req) => {
    admin(req);
    const q = parse(z.object({
      severity: z.enum(['info', 'warn', 'error']).optional(),
      entity: z.string().max(40).optional(),
      limit: z.coerce.number().int().min(1).max(500).default(200),
      offset: z.coerce.number().int().min(0).default(0),
    }), req.query);
    const run = await loadRun(req.params.id);
    const where = and(eq(importIssues.importRunId, run.id), q.severity ? eq(importIssues.severity, q.severity) : undefined, q.entity ? eq(importIssues.entity, q.entity) : undefined);
    const [rows, [{ n }]] = await Promise.all([
      db.select().from(importIssues).where(where)
        .orderBy(sql`case ${importIssues.severity} when 'error' then 0 when 'warn' then 1 else 2 end`, asc(importIssues.createdAt))
        .limit(q.limit).offset(q.offset),
      db.select({ n: sql<number>`count(*)::int` }).from(importIssues).where(where),
    ]);
    return { total: n, items: rows };
  });

  app.get<{ Params: { id: string } }>('/runs/:id/report', async (req, reply) => {
    admin(req);
    const { format } = parse(z.object({ format: z.enum(['json', 'csv']).default('json') }), req.query);
    const run = await loadRun(req.params.id);
    const report = await buildReport(run.id);
    const name = `clickup-import-${run.mode}-${(run.startedAt ?? run.createdAt).toISOString().slice(0, 16).replace(/[:T]/g, '-')}`;
    reply.header('content-disposition', `attachment; filename="${name}.${format}"`);
    if (format === 'csv') return reply.type('text/csv; charset=utf-8').send(reportCsv(report));
    return reply.type('application/json').send(JSON.stringify(report, null, 2));
  });

  // ── user mapping (M-03) ──
  app.get('/users', async (req) => {
    admin(req);
    const rows = await db.select({
      m: importUserMappings,
      user: { id: users.id, displayName: users.displayName, email: users.email, isPlaceholder: users.isPlaceholder, avatarUrl: users.avatarUrl },
    }).from(importUserMappings).leftJoin(users, eq(users.id, importUserMappings.userId))
      .orderBy(sql`case ${importUserMappings.resolution} when 'unresolved' then 0 else 1 end`, asc(importUserMappings.clickupName));
    return rows.map(({ m, user }) => ({ ...m, user: user?.id ? user : null }));
  });

  app.post('/users/refresh', async (req) => {
    admin(req);
    const api = await createClickUpClient();
    const r = await refreshUserMappings(api);
    return { workspace: r.workspace.name, members: r.workspace.members.length, created: r.created };
  });

  app.put<{ Params: { cuId: string } }>('/users/:cuId', async (req) => {
    admin(req);
    const body = parse(z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('map'), userId: z.string().uuid() }),
      z.object({ kind: z.literal('placeholder'), role: z.number().int().min(1).max(4).nullable().optional() }),
      z.object({ kind: z.literal('skip') }),
      z.object({ kind: z.literal('reset') }),
    ]), req.body);
    await resolveUserMapping(req.params.cuId, body);
    return { ok: true };
  });

  /** Bulk: placeholders for / skip every unresolved user. */
  app.post('/users/bulk', async (req) => {
    admin(req);
    const { kind, role } = parse(z.object({ kind: z.enum(['placeholder', 'skip']), role: z.number().int().min(1).max(4).optional() }), req.body);
    const pending = await db.select().from(importUserMappings).where(eq(importUserMappings.resolution, 'unresolved'));
    for (const p of pending) await resolveUserMapping(p.clickupUserId, kind === 'skip' ? { kind } : { kind, role: role ?? 3 });
    return { updated: pending.length };
  });
}
