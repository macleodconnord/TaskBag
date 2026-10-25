import { asc, eq, sql } from 'drizzle-orm';
import { db } from '../../db/client';
import { importIssues, importRuns } from '../../db/schema';
import { NotFound } from '../../lib/errors';
import { activeRun } from './runner';
import { STAGE_LABELS, STAGES, type RunCursor, type RunRow } from './context';

/** The run as the admin UI sees it; live values from this process when it is executing the run. */
export async function runView(run: RunRow) {
  const live = activeRun();
  const ctx = live?.runId === run.id ? live.ctx : null;
  const cursor = (ctx?.cursor ?? run.cursor) as RunCursor;
  const counts = await db.select({ severity: importIssues.severity, n: sql<number>`count(*)::int` }).from(importIssues)
    .where(eq(importIssues.importRunId, run.id)).groupBy(importIssues.severity);
  return {
    id: run.id,
    mode: run.mode,
    status: run.status,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    createdAt: run.createdAt,
    since: run.since,
    error: run.error,
    stats: ctx?.stats ?? run.stats,
    stage: cursor.stage ?? null,
    stages: STAGES.filter((s) => !(s === 'validation' && run.mode === 'dry_run')).map((s) => ({ key: s, label: STAGE_LABELS[s], done: !!cursor.done?.includes(s) })),
    progress: cursor.progress ?? null,
    awaitingUserMapping: !!cursor.awaitingUserMapping,
    options: cursor.options ?? null,
    validation: cursor.validation ?? null,
    client: ctx ? ctx.api.stats() : cursor.client ?? null,
    workspaceName: cursor.workspaceName ?? null,
    executingHere: !!ctx || live?.runId === run.id,
    issueCounts: Object.fromEntries(counts.map((c) => [c.severity, c.n])) as Record<string, number>,
  };
}

export async function buildReport(runId: string) {
  const [run] = await db.select().from(importRuns).where(eq(importRuns.id, runId));
  if (!run) throw new NotFound();
  const issues = await db.select().from(importIssues).where(eq(importIssues.importRunId, runId)).orderBy(asc(importIssues.createdAt));
  const v = await runView(run);
  return {
    run: { id: v.id, mode: v.mode, status: v.status, startedAt: v.startedAt, finishedAt: v.finishedAt, since: v.since, error: v.error, workspace: v.workspaceName, options: v.options },
    counts: v.stats,
    issueCounts: v.issueCounts,
    issues: issues.map((i) => ({ severity: i.severity, entity: i.entity, externalId: i.externalId, message: i.message })),
    validation: v.validation,
    api: v.client,
  };
}

const csvCell = (v: unknown) => {
  const s = v === null || v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/** One CSV: entity counts, then issues, then validation rows (a `section` column tells them apart). */
export function reportCsv(r: Awaited<ReturnType<typeof buildReport>>) {
  const rows: unknown[][] = [['section', 'entity', 'severity', 'external_id', 'seen', 'created', 'updated', 'unchanged', 'skipped', 'failed', 'message']];
  for (const [entity, c] of Object.entries(r.counts ?? {})) {
    rows.push(['count', entity, '', '', c.seen ?? 0, c.created ?? 0, c.updated ?? 0, c.unchanged ?? 0, c.skipped ?? 0, c.failed ?? 0, '']);
  }
  for (const i of r.issues) rows.push(['issue', i.entity, i.severity, i.externalId, '', '', '', '', '', '', i.message]);
  for (const l of r.validation?.lists ?? []) {
    rows.push(['validation', 'list', l.ok ? 'ok' : 'warn', l.listExt, l.clickup, l.ours, '', '', '', '', `${l.name}: ClickUp ${l.clickup}, imported ${l.ours}`]);
  }
  return rows.map((row) => row.map(csvCell).join(',')).join('\r\n') + '\r\n';
}
