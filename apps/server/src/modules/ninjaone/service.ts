import { db } from '../../db/client';
import { ninjaSyncState } from '../../db/schema';
import { log } from '../../lib/log';
import { recordRun } from '../integrations/health';
import { DbNinjaStore, makeNinjaClient, ninjaSettings } from './store';
import { NinjaSync } from './sync';

let pollInFlight: Promise<unknown> | null = null;
let lastPollStartedAt = 0;
let startupChecked = false;

async function engine() {
  const s = await ninjaSettings();
  if (!s.enabled) return null;
  const client = makeNinjaClient(s);
  return { s, sync: new NinjaSync(client, new DbNinjaStore(s.region), s) };
}

/** `ninja.poll` once (skipped while a reconcile runs). */
export async function runPoll() {
  const e = await engine();
  if (!e) return { skipped: 'disabled' };
  lastPollStartedAt = Date.now();
  const p = recordRun('ninjaone', 'ninja.poll', async () => e.sync.poll());
  pollInFlight = p.catch(() => undefined);
  try {
    return await p;
  } finally {
    pollInFlight = null;
  }
}

/** `ninja.reconcile` over every source board (also the initial backfill). */
export async function runReconcile(reason: string) {
  const e = await engine();
  if (!e) return { skipped: 'disabled' };
  if (pollInFlight) await pollInFlight; // don't race an in-flight poll
  log.info({ reason }, 'ninjaone reconcile starting');
  return recordRun('ninjaone', 'ninja.reconcile', async () => ({ reason, ...(await e.sync.reconcile()) }));
}

/** Scheduler tick for the poll (the interval comes from config, so the job ticks often and checks). */
export async function pollTick() {
  const s = await ninjaSettings();
  if (!s.enabled || !s.deltaBoardId) return;
  if (Date.now() - lastPollStartedAt < s.pollIntervalSec * 1000) return;
  await runPoll().catch(() => undefined);
}

/** "M H * * *" or "HH:MM" → minutes after midnight (server local time). */
export function parseDailyTime(spec: string): number | null {
  const hhmm = /^(\d{1,2}):(\d{2})$/.exec(spec.trim());
  if (hhmm) return Number(hhmm[1]) * 60 + Number(hhmm[2]);
  const cron = /^(\d{1,2})\s+(\d{1,2})\s+\*\s+\*\s+\*$/.exec(spec.trim());
  if (cron) return Number(cron[2]) * 60 + Number(cron[1]);
  return null;
}

/** Scheduler tick for reconcile: at startup when stale, the initial backfill, and the nightly run. */
export async function reconcileTick() {
  const e = await engine();
  if (!e || !e.s.sourceBoardIds.length) return;
  const state = await new DbNinjaStore(e.s.region).loadState();
  if (state.reconcileRunning) return;
  if (!startupChecked) {
    startupChecked = true;
    if (await e.sync.isStale()) {
      await runReconcile(state.lastSuccessfulPollAt ? 'startup: last poll is stale' : 'initial backfill').catch(() => undefined);
      return;
    }
  }
  if (!state.lastReconcileAt) {
    await runReconcile('initial backfill').catch(() => undefined);
    return;
  }
  const at = parseDailyTime(e.s.reconcileCron);
  if (at === null) return;
  const now = new Date();
  const due = new Date(now);
  due.setHours(Math.floor(at / 60), at % 60, 0, 0);
  if (now >= due && state.lastReconcileAt < due) await runReconcile('nightly').catch(() => undefined);
}

/** A crash mid-reconcile would leave the flag set forever; clear it at startup. */
export async function resetReconcileFlag() {
  await db.update(ninjaSyncState).set({ reconcileRunning: false });
}

/** "Test connection": token with the monitoring scope, list boards, run the delta board (page 1). */
export async function testNinja(): Promise<{ ok: boolean; detail: string; data?: unknown }> {
  const s = await ninjaSettings();
  let client;
  try {
    client = makeNinjaClient(s);
  } catch (err) {
    return { ok: false, detail: (err as Error).message };
  }
  const lines: string[] = [];
  try {
    await client.authenticate();
    lines.push(`Token OK (${client.host}, scope monitoring)`);
    const boards = await client.listBoards();
    lines.push(`${boards.length} board(s): ${boards.slice(0, 15).map((b) => `${b.id} ${b.name}`).join(', ')}`);
    if (s.deltaBoardId) {
      const page = await client.runBoard(s.deltaBoardId, { pageSize: 50 });
      lines.push(`Delta board ${s.deltaBoardId}: ${page.tickets.length} ticket(s) on page 1`);
    } else {
      lines.push('No delta board configured yet');
    }
    return { ok: true, detail: lines.join('\n'), data: { boards } };
  } catch (err) {
    lines.push(err instanceof Error ? err.message : String(err));
    return { ok: false, detail: lines.join('\n') };
  }
}
