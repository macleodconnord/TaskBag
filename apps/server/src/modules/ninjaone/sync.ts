import { createHash } from 'node:crypto';
import type { NinjaClient, NinjaTicket } from './client';

/**
 * NinjaOne poll / reconcile engine (architecture §9.3). Pure logic over a `NinjaStore` so it can be
 * tested with a fake client and an in-memory store; `store.ts` is the Postgres implementation.
 *
 * - poll: page the whole delta board ("updated in the last 24h"), process only hash-changed tickets.
 * - reconcile: same over every source board. Poll is skipped while a reconcile runs.
 * - A ticket that leaves the delta board changes nothing (we never infer anything from absence).
 */
export interface NormalizedTicket {
  id: number;
  boardId: number;
  subject: string;
  description: string;
  status: string | null;
  statusId: number | null;
  priority: string | null;
  severity: string | null;
  orgId: number | null;
  formId: number | null;
  lastUpdated: number | null;
  /** merged board row + ticket detail, used for field mapping */
  raw: Record<string, unknown>;
}

export type ApplyResult = 'created' | 'updated' | 'unmapped';

export interface NinjaSyncState {
  lastSuccessfulPollAt: Date | null;
  lastReconcileAt: Date | null;
  reconcileRunning: boolean;
}

export interface NinjaStore {
  loadState(): Promise<NinjaSyncState>;
  markPollSuccess(at: Date): Promise<void>;
  /** Atomically flip reconcile_running false → true. */
  tryBeginReconcile(): Promise<boolean>;
  endReconcile(at: Date, status: 'ok' | 'error', stats: Record<string, unknown>): Promise<void>;
  getHashes(ticketIds: number[]): Promise<Map<number, string>>;
  touch(ticketIds: number[], at: Date): Promise<void>;
  /** Upsert the mirror row (snapshot + hash) and create/update the linked task, comments, events. */
  applyTicket(ticket: NormalizedTicket, hash: string, client: NinjaClient): Promise<ApplyResult>;
}

export interface NinjaSyncConfig {
  deltaBoardId?: number;
  sourceBoardIds?: number[];
  reconcileIfStaleHours?: number;
}

export interface BatchStats {
  [k: string]: number;
  seen: number;
  changed: number;
  created: number;
  updated: number;
  unmapped: number;
  errors: number;
}

const emptyStats = (): BatchStats => ({ seen: 0, changed: 0, created: 0, updated: 0, unmapped: 0, errors: 0 });

/** Stable JSON (sorted keys) → sha256, so key order in API responses doesn't fake a change. */
export function ticketHash(row: unknown): string {
  const stable = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(stable);
    if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v as object).sort().map((k) => [k, stable((v as Record<string, unknown>)[k])]));
    return v;
  };
  return createHash('sha256').update(JSON.stringify(stable(row))).digest('hex');
}

const num = (v: unknown): number | null => {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : typeof v === 'number' ? v : NaN;
  return Number.isFinite(n) ? n : null;
};
const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : typeof v === 'number' ? String(v) : null);
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

/** Board rows and ticket details use slightly different shapes; normalize defensively. */
export function normalizeTicket(row: NinjaTicket, detail: Record<string, unknown> | null, boardId: number): NormalizedTicket {
  const raw = { ...row, ...(detail ?? {}) } as Record<string, unknown>;
  const statusObj = obj(raw.status);
  const status = str(statusObj.displayName) ?? str(statusObj.name) ?? str(raw.status);
  const description = obj(raw.description);
  const org = obj(raw.organization);
  const form = obj(raw.ticketForm ?? raw.form);
  return {
    id: Number(raw.id),
    boardId,
    subject: str(raw.subject) ?? str(raw.summary) ?? str(raw.title) ?? `NinjaOne ticket #${raw.id}`,
    description: str(description.body) ?? str(raw.description) ?? '',
    status,
    statusId: num(statusObj.statusId) ?? num(raw.statusId),
    priority: str(raw.priority),
    severity: str(raw.severity),
    orgId: num(raw.clientId) ?? num(raw.organizationId) ?? num(org.id),
    formId: num(raw.ticketFormId) ?? num(form.id),
    lastUpdated: num(raw.lastUpdated) ?? num(raw.lastUpdatedTime) ?? num(raw.updateTime),
    raw,
  };
}

export class NinjaSync {
  constructor(
    private client: NinjaClient,
    private store: NinjaStore,
    private config: NinjaSyncConfig,
    private now: () => Date = () => new Date(),
  ) {}

  private async processBoard(boardId: number, stats: BatchStats) {
    const rows = await this.client.runWholeBoard(boardId);
    stats.seen += rows.length;
    const hashes = await this.store.getHashes(rows.map((r) => Number(r.id)));
    const unchanged: number[] = [];
    for (const row of rows) {
      const id = Number(row.id);
      const hash = ticketHash(row);
      if (hashes.get(id) === hash) {
        unchanged.push(id);
        continue;
      }
      stats.changed++;
      try {
        // board rows only carry the board's columns; the detail has description, form, attributes
        const detail = await this.client.getTicket(id).catch(() => null);
        const result = await this.store.applyTicket(normalizeTicket(row, detail, boardId), hash, this.client);
        stats[result]++;
      } catch (err) {
        // the hash isn't saved, so the ticket is retried on the next run
        stats.errors++;
        (stats as Record<string, unknown>).lastError = err instanceof Error ? err.message : String(err);
      }
    }
    if (unchanged.length) await this.store.touch(unchanged, this.now());
  }

  /** `ninja.poll`: the whole delta board. Skipped while a reconcile runs. */
  async poll(): Promise<BatchStats | { skipped: string }> {
    if (!this.config.deltaBoardId) return { skipped: 'no delta board configured' };
    const state = await this.store.loadState();
    if (state.reconcileRunning) return { skipped: 'reconcile running' };
    const stats = emptyStats();
    await this.processBoard(this.config.deltaBoardId, stats);
    await this.store.markPollSuccess(this.now());
    return stats;
  }

  /** `ninja.reconcile`: every source board. */
  async reconcile(): Promise<BatchStats | { skipped: string }> {
    const boards = [...new Set(this.config.sourceBoardIds ?? [])];
    if (!boards.length) return { skipped: 'no source boards configured' };
    if (!(await this.store.tryBeginReconcile())) return { skipped: 'reconcile already running' };
    const stats = emptyStats();
    try {
      for (const b of boards) await this.processBoard(b, stats);
      // a full pass over the source boards is at least as fresh as a delta poll
      await this.store.markPollSuccess(this.now());
      await this.store.endReconcile(this.now(), 'ok', stats);
      return stats;
    } catch (err) {
      await this.store.endReconcile(this.now(), 'error', { ...stats, error: err instanceof Error ? err.message : String(err) });
      throw err;
    }
  }

  /** True when the last successful poll is older than `reconcileIfStaleHours` (or never happened). */
  async isStale(): Promise<boolean> {
    const state = await this.store.loadState();
    const hours = this.config.reconcileIfStaleHours ?? 20;
    if (!state.lastSuccessfulPollAt) return true;
    return this.now().getTime() - state.lastSuccessfulPollAt.getTime() > hours * 3600_000;
  }
}
