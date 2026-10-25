import { and, desc, eq, inArray } from 'drizzle-orm';
import { db, sqlClient } from '../../db/client';
import { importRuns, workspaces } from '../../db/schema';
import { systemUserId } from '../../db/seed';
import { Conflict, NotFound, Validation } from '../../lib/errors';
import { log } from '../../lib/log';
import { createClickUpClient } from './clickup/client';
import {
  ControlSignal, DEFAULT_OPTIONS, ImportContext, STAGES, type RunCursor, type RunMode, type RunOptions, type RunRow, type Stage,
} from './context';
import { runActivity } from './stages/activity';
import { runDocs } from './stages/docs';
import { fetchFieldPlan, runFields, type FieldPlan } from './stages/fields';
import { fetchHierarchy, runHierarchy } from './stages/hierarchy';
import { runPermissions } from './stages/permissions';
import { runRelations, runTasks } from './stages/tasks';
import { loadUserMap, runUsers } from './stages/users';
import { runValidation } from './stages/validation';
import { runViews } from './stages/views';

/** Cross-process guard (dev server, a second API, the CLI): only one import executes at a time. */
const LOCK_KEY = 73_400_117;

let active: { runId: string; ctx: ImportContext | null; done: Promise<void> } | null = null;

/** Live context of the run executing in this process (fresher than the DB row). */
export const activeRun = () => active;

async function withLock<T>(fn: () => Promise<T>): Promise<{ ok: true; value: T } | { ok: false }> {
  const conn = await sqlClient.reserve();
  try {
    const [r] = await conn`select pg_try_advisory_lock(${LOCK_KEY}) as ok`;
    if (!r.ok) return { ok: false };
    try {
      return { ok: true, value: await fn() };
    } finally {
      await conn`select pg_advisory_unlock(${LOCK_KEY})`;
    }
  } finally {
    conn.release();
  }
}

/** True when no process is executing an import right now. */
export async function lockIsFree() {
  if (active) return false;
  const r = await withLock(async () => true);
  return r.ok;
}

const OPEN_STATUSES = ['queued', 'running', 'paused'] as const;

export async function openRun(): Promise<RunRow | null> {
  const [r] = await db.select().from(importRuns).where(inArray(importRuns.status, [...OPEN_STATUSES])).orderBy(desc(importRuns.createdAt)).limit(1);
  return r ?? null;
}

/** Default delta window: since the last successful full/delta run started (minus 10 minutes of slack). */
export async function defaultSince(): Promise<Date | null> {
  const [r] = await db.select().from(importRuns)
    .where(and(eq(importRuns.status, 'succeeded'), inArray(importRuns.mode, ['full', 'delta'])))
    .orderBy(desc(importRuns.startedAt)).limit(1);
  return r?.startedAt ? new Date(r.startedAt.getTime() - 10 * 60_000) : null;
}

export async function createRun(input: { mode: RunMode; startedBy: string | null; options?: Partial<RunOptions>; since?: Date | null }) {
  const open = await openRun();
  if (open) throw new Conflict(`An import is already ${open.status}; resume or cancel it first`);
  let since: Date | null = null;
  if (input.mode === 'delta') {
    since = input.since ?? (await defaultSince());
    if (!since) throw new Validation('A delta import needs a previous successful full import (or an explicit "since")');
  }
  const options: RunOptions = { ...DEFAULT_OPTIONS, ...(input.options ?? {}) };
  const [run] = await db.insert(importRuns).values({
    mode: input.mode, status: 'queued', startedBy: input.startedBy, since, cursor: { options } satisfies RunCursor,
  }).returning();
  return run;
}

/** Start (or resume) executing a run in the background. Returns a promise that settles when it stops. */
export function launch(runId: string): Promise<void> {
  if (active) {
    if (active.runId === runId) return active.done;
    throw new Conflict('Another import is running in this process');
  }
  const slot: { runId: string; ctx: ImportContext | null; done: Promise<void> } = { runId, ctx: null, done: Promise.resolve() };
  active = slot;
  slot.done = (async () => {
    try {
      const r = await withLock(() => execute(runId, slot));
      if (!r.ok) log.warn({ runId }, 'import: another process holds the import lock');
    } catch (err) {
      log.error({ err, runId }, 'import: run crashed');
    } finally {
      if (active === slot) active = null;
    }
  })();
  return slot.done;
}

export async function pauseRun(runId: string) {
  const [run] = await db.select().from(importRuns).where(eq(importRuns.id, runId));
  if (!run) throw new NotFound();
  if (active?.runId === runId && active.ctx) {
    active.ctx.control = 'pause';
    return;
  }
  if (run.status === 'running' || run.status === 'queued') {
    if (!(await lockIsFree())) throw new Conflict('The run is executing in another process; pause it there');
    await db.update(importRuns).set({ status: 'paused' }).where(eq(importRuns.id, runId));
  }
}

export async function cancelRun(runId: string) {
  const [run] = await db.select().from(importRuns).where(eq(importRuns.id, runId));
  if (!run) throw new NotFound();
  if (active?.runId === runId && active.ctx) {
    active.ctx.control = 'cancel';
    return;
  }
  if (!OPEN_STATUSES.includes(run.status as (typeof OPEN_STATUSES)[number])) throw new Validation(`The run is already ${run.status}`);
  if (run.status !== 'paused' && !(await lockIsFree())) throw new Conflict('The run is executing in another process; cancel it there');
  await db.update(importRuns).set({ status: 'cancelled', finishedAt: new Date() }).where(eq(importRuns.id, runId));
}

export async function resumeRun(runId: string) {
  const [run] = await db.select().from(importRuns).where(eq(importRuns.id, runId));
  if (!run) throw new NotFound();
  if (active?.runId === runId) return;
  if (run.status !== 'paused' && run.status !== 'running' && run.status !== 'queued') throw new Validation(`A ${run.status} run cannot be resumed`);
  if (!(await lockIsFree())) throw new Conflict('An import is already executing');
  void launch(runId);
}

async function setStatus(runId: string, patch: Partial<typeof importRuns.$inferInsert>) {
  await db.update(importRuns).set(patch).where(eq(importRuns.id, runId));
}

async function execute(runId: string, slot: { ctx: ImportContext | null }) {
  const [run] = await db.select().from(importRuns).where(eq(importRuns.id, runId));
  if (!run || !OPEN_STATUSES.includes(run.status as (typeof OPEN_STATUSES)[number])) return;
  if (run.mode === 'dry_run' && run.status !== 'queued') {
    // dry runs keep their working set in memory: restart from scratch (issues are deduplicated)
    run.stats = {};
    run.cursor = { options: (run.cursor as RunCursor).options };
  }
  await setStatus(runId, { status: 'running', startedAt: run.startedAt ?? new Date(), error: null });
  let ctx: ImportContext;
  try {
    ctx = new ImportContext({ ...run, status: 'running' }, await createClickUpClient());
  } catch (err) {
    await setStatus(runId, { status: 'failed', error: (err as Error).message, finishedAt: new Date() });
    return;
  }
  slot.ctx = ctx;
  ctx.cursor.awaitingUserMapping = false;
  ctx.systemUserId = await systemUserId('clickup');
  ctx.workspaceId = (await db.select({ id: workspaces.id }).from(workspaces).limit(1))[0].id;
  await ctx.loadIssueKeys();
  if (!ctx.dry) ctx.users = await loadUserMap();
  const done = new Set<Stage>(ctx.cursor.done);
  let fieldPlan = ctx.cursor.fieldPlan ?? null;

  try {
    for (const stage of STAGES) {
      if (done.has(stage)) continue;
      if (stage === 'validation' && ctx.dry) continue;
      ctx.cursor.stage = stage;
      ctx.progress(0, 0);
      await ctx.checkpoint(true);
      log.info({ runId, stage }, 'import: stage');
      if (stage !== 'users' && !ctx.plan) {
        ctx.progress(0, 0, 'reading the ClickUp hierarchy');
        ctx.plan = await fetchHierarchy(ctx);
      }
      if (['tasks', 'validation', 'views'].includes(stage) && !fieldPlan) {
        fieldPlan = await fetchFieldPlan(ctx);
        ctx.cursor.fieldPlan = fieldPlan;
      }
      switch (stage) {
        case 'users': await runUsers(ctx); break;
        case 'hierarchy': await runHierarchy(ctx); break;
        case 'fields':
          fieldPlan = await fetchFieldPlan(ctx);
          ctx.cursor.fieldPlan = fieldPlan;
          await runFields(ctx, fieldPlan);
          break;
        case 'tasks': await runTasks(ctx, fieldPlan!); break;
        case 'relations': await runRelations(ctx); break;
        case 'activity': await runActivity(ctx); break;
        case 'docs': await runDocs(ctx); break;
        case 'views': await runViews(ctx, fieldPlan!); break;
        case 'permissions': await runPermissions(ctx); break;
        case 'validation': await runValidation(ctx, fieldPlan!); break;
      }
      done.add(stage);
      ctx.cursor.done = [...done];
      await ctx.checkpoint(true);
    }
    reportDropped(ctx);
    ctx.cursor.stage = null;
    await ctx.save();
    await setStatus(runId, { status: 'succeeded', finishedAt: new Date() });
    log.info({ runId, stats: ctx.stats }, 'import: finished');
  } catch (err) {
    if (err instanceof ControlSignal) {
      await ctx.save();
      await setStatus(runId, err.kind === 'pause' ? { status: 'paused' } : { status: 'cancelled', finishedAt: new Date() });
      log.info({ runId, kind: err.kind }, 'import: stopped');
      return;
    }
    log.error({ err, runId, stage: ctx.cursor.stage }, 'import: failed');
    ctx.issue('error', ctx.cursor.stage ?? 'run', null, `Stage "${ctx.cursor.stage}" failed: ${(err as Error).message}`);
    await ctx.save();
    await setStatus(runId, { status: 'failed', error: (err as Error).message, finishedAt: new Date() });
  }
}

/** Dropped features are reported as info issues (time tracking, watchers, reactions, …). */
function reportDropped(ctx: ImportContext) {
  const d = ctx.cursor.dropped ?? {};
  const n = (k: string) => d[k] ?? 0;
  ctx.issue('info', 'time_entry', null, `Time entries are not imported (time tracking is not part of this app)${n('tasks_with_time_tracked') ? `: ${n('tasks_with_time_tracked')} task(s) have tracked time in ClickUp` : ''}`);
  if (n('watchers')) ctx.issue('info', 'watcher', null, `${n('watchers')} task watcher(s) are not imported (watchers are not supported); assignees and mentions still get notifications`);
  if (n('comment_reactions')) ctx.issue('info', 'comment', null, `${n('comment_reactions')} comment reaction(s) are not imported (reactions are not supported)`);
  if (n('assigned_comments')) ctx.issue('info', 'comment', null, `${n('assigned_comments')} assigned comment(s) are imported as plain comments (assigned comments are not supported)`);
  if (n('guest_visibility_toggles')) ctx.issue('info', 'user', null, `${n('guest_visibility_toggles')} guest(s): ClickUp guest permission toggles are not imported`);
  ctx.issue('info', 'run', null, 'Automations, goals and dashboards are not imported (not supported here)');
}

/** Re-run M-12 validation for a finished run (in the background). */
export function revalidate(runId: string) {
  if (active) throw new Conflict('An import is running');
  const slot: { runId: string; ctx: ImportContext | null; done: Promise<void> } = { runId, ctx: null, done: Promise.resolve() };
  active = slot;
  slot.done = (async () => {
    try {
      await withLock(async () => {
        const [run] = await db.select().from(importRuns).where(eq(importRuns.id, runId));
        if (!run || run.mode === 'dry_run') return;
        const ctx = new ImportContext(run, await createClickUpClient());
        slot.ctx = ctx;
        ctx.systemUserId = await systemUserId('clickup');
        ctx.users = await loadUserMap();
        await ctx.loadIssueKeys();
        ctx.cursor.stage = 'validation';
        ctx.plan = await fetchHierarchy(ctx);
        const fp = ctx.cursor.fieldPlan ?? (await fetchFieldPlan(ctx));
        try {
          await runValidation(ctx, fp);
        } catch (err) {
          if (!(err instanceof ControlSignal)) ctx.issue('error', 'validation', null, `Validation failed: ${(err as Error).message}`);
        }
        ctx.cursor.stage = null;
        await ctx.save();
      });
    } catch (err) {
      log.error({ err, runId }, 'import: revalidation crashed');
    } finally {
      if (active === slot) active = null;
    }
  })();
  return slot.done;
}

/** Startup: continue runs that were executing when the process stopped. */
export async function resumeInterruptedRuns() {
  const runs = await db.select().from(importRuns).where(inArray(importRuns.status, ['running', 'queued']));
  for (const r of runs) {
    if (!(await lockIsFree())) return;
    log.info({ runId: r.id }, 'import: resuming interrupted run');
    void launch(r.id);
    return;
  }
}
