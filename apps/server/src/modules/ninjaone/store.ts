import { NINJA_REGIONS, plainToRichText } from '@app/shared';
import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { db } from '../../db/client';
import { comments, customFields, lists, ninjaBoardMappings, ninjaSyncState, ninjaTickets, taskFieldValues, tasks } from '../../db/schema';
import { systemUserId } from '../../db/seed';
import { getIntegrationConfig } from '../../lib/integration-config';
import { emit } from '../../lib/events';
import { log } from '../../lib/log';
import { runTx } from '../../lib/tx';
import { addComment } from '../comments/routes';
import { statusesForList } from '../hierarchy/service';
import { createTask, updateTask } from '../tasks/service';
import { NinjaClient } from './client';
import type { ApplyResult, NinjaStore, NinjaSyncState, NormalizedTicket } from './sync';

export interface NinjaSettings {
  enabled: boolean;
  region: string;
  clientId: string;
  clientSecret: string;
  deltaBoardId?: number;
  sourceBoardIds: number[];
  pollIntervalSec: number;
  reconcileCron: string;
  reconcileIfStaleHours: number;
}

export async function ninjaSettings(): Promise<NinjaSettings> {
  const cfg = await getIntegrationConfig('ninjaone');
  const c = cfg.config as Record<string, unknown>;
  const n = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
  return {
    enabled: cfg.enabled,
    region: typeof c.region === 'string' ? c.region : 'us',
    clientId: typeof c.clientId === 'string' ? c.clientId : '',
    clientSecret: cfg.secrets.clientSecret ?? '',
    deltaBoardId: typeof c.deltaBoardId === 'number' ? c.deltaBoardId : undefined,
    sourceBoardIds: Array.isArray(c.sourceBoardIds) ? c.sourceBoardIds.map(Number).filter(Number.isFinite) : [],
    pollIntervalSec: Math.max(30, n(c.pollIntervalSec, 120)),
    reconcileCron: typeof c.reconcileCron === 'string' && c.reconcileCron ? c.reconcileCron : '0 2 * * *',
    reconcileIfStaleHours: Math.min(23, Math.max(1, n(c.reconcileIfStaleHours, 20))),
  };
}

export function makeNinjaClient(s: NinjaSettings) {
  if (!s.clientId || !s.clientSecret) throw new Error('NinjaOne client ID and client secret are required');
  return new NinjaClient({ region: s.region, clientId: s.clientId, clientSecret: s.clientSecret });
}

export const ninjaTicketUrl = (region: string, ticketId: number) =>
  `https://${(NINJA_REGIONS as Record<string, string>)[region] ?? NINJA_REGIONS.us}/#/ticketing/ticket/${ticketId}`;

// ───────────── mapping helpers (exported for tests / admin UI) ─────────────

type Mapping = typeof ninjaBoardMappings.$inferSelect;
interface Filters { orgIds?: number[]; statuses?: string[]; priorities?: string[]; formIds?: number[] }

const ciIn = (list: string[] | undefined, v: string | null) => !list?.length || (!!v && list.some((x) => x.toLowerCase() === v.toLowerCase()));
const numIn = (list: number[] | undefined, v: number | null) => !list?.length || (v !== null && list.map(Number).includes(v));

export function mappingMatches(m: Pick<Mapping, 'boardIds' | 'filters' | 'enabled'>, t: NormalizedTicket) {
  if (!m.enabled) return false;
  const f = m.filters as Filters;
  return (!m.boardIds.length || m.boardIds.map(Number).includes(t.boardId))
    && numIn(f.orgIds, t.orgId) && ciIn(f.statuses, t.status) && ciIn(f.priorities, t.priority) && numIn(f.formIds, t.formId);
}

const PRIORITY: Record<string, number | null> = { URGENT: 1, CRITICAL: 1, HIGH: 2, MEDIUM: 3, NORMAL: 3, LOW: 4, NONE: null };
export const mapPriority = (p: string | null) => (p ? PRIORITY[p.toUpperCase()] ?? null : null);

/** Resolve a field-map path: `subject`, `severity`, `requester.name`, `attribute:<id>` / `attributes.<id>`. */
export function readPath(raw: Record<string, unknown>, path: string): unknown {
  const attr = /^(?:attribute:|attributes\.|attributeValues\.)(\d+)$/.exec(path);
  if (attr) {
    const list = Array.isArray(raw.attributeValues) ? raw.attributeValues as Array<Record<string, unknown>> : [];
    return list.find((a) => String(a.attributeId) === attr[1])?.value ?? null;
  }
  let cur: unknown = raw;
  for (const part of path.split('.')) {
    if (!cur || typeof cur !== 'object') return null;
    cur = (cur as Record<string, unknown>)[part];
  }
  if (cur && typeof cur === 'object' && !Array.isArray(cur)) {
    const o = cur as Record<string, unknown>;
    return o.displayName ?? o.name ?? o.value ?? JSON.stringify(cur);
  }
  return cur ?? null;
}

const isPublicComment = (e: { type?: string; publicEntry?: boolean; body?: string; htmlBody?: string }) =>
  (e.type ?? 'COMMENT').toUpperCase() === 'COMMENT' && e.publicEntry !== false && !!(e.body ?? e.htmlBody)?.trim();

const stripHtml = (h: string) => h.replace(/<br\s*\/?>/gi, '\n').replace(/<\/p>/gi, '\n\n').replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ')
  .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').trim();

const toDate = (v: unknown): Date | undefined => {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
  if (Number.isFinite(n)) return new Date(n < 1e12 ? n * 1000 : n); // NinjaOne uses epoch seconds (sometimes fractional)
  const d = typeof v === 'string' ? new Date(v) : undefined;
  return d && !Number.isNaN(d.getTime()) ? d : undefined;
};

// ───────────── Postgres store ─────────────

export class DbNinjaStore implements NinjaStore {
  constructor(private region: string) {}

  async loadState(): Promise<NinjaSyncState> {
    await db.insert(ninjaSyncState).values({ id: 1 }).onConflictDoNothing();
    const [s] = await db.select().from(ninjaSyncState).where(eq(ninjaSyncState.id, 1));
    return { lastSuccessfulPollAt: s.lastSuccessfulPollAt, lastReconcileAt: s.lastReconcileAt, reconcileRunning: s.reconcileRunning };
  }

  async markPollSuccess(at: Date) {
    await db.update(ninjaSyncState).set({ lastSuccessfulPollAt: at }).where(eq(ninjaSyncState.id, 1));
  }

  async tryBeginReconcile() {
    await db.insert(ninjaSyncState).values({ id: 1 }).onConflictDoNothing();
    const rows = await db.update(ninjaSyncState).set({ reconcileRunning: true })
      .where(and(eq(ninjaSyncState.id, 1), eq(ninjaSyncState.reconcileRunning, false))).returning({ id: ninjaSyncState.id });
    return rows.length > 0;
  }

  async endReconcile(at: Date, status: 'ok' | 'error', stats: Record<string, unknown>) {
    await db.update(ninjaSyncState).set({ reconcileRunning: false, lastReconcileAt: at, lastReconcileStatus: status, lastReconcileStats: stats })
      .where(eq(ninjaSyncState.id, 1));
  }

  async getHashes(ids: number[]) {
    if (!ids.length) return new Map<number, string>();
    const rows = await db.select({ id: ninjaTickets.ticketId, h: ninjaTickets.snapshotHash }).from(ninjaTickets).where(inArray(ninjaTickets.ticketId, ids));
    return new Map(rows.map((r) => [r.id, r.h]));
  }

  async touch(ids: number[], at: Date) {
    if (ids.length) await db.update(ninjaTickets).set({ lastPolledAt: at }).where(inArray(ninjaTickets.ticketId, ids));
  }

  async applyTicket(t: NormalizedTicket, hash: string, client: NinjaClient): Promise<ApplyResult> {
    const actor = await systemUserId('ninjaone');
    const mappings = await db.select().from(ninjaBoardMappings).orderBy(asc(ninjaBoardMappings.position), asc(ninjaBoardMappings.createdAt));
    const [prev] = await db.select().from(ninjaTickets).where(eq(ninjaTickets.ticketId, t.id));
    const prevSnap = (prev?.snapshot ?? null) as Record<string, unknown> | null;
    const prevStatus = (prevSnap?.__status as string | undefined) ?? null;
    const prevSubject = (prevSnap?.__subject as string | undefined) ?? null;

    let result: ApplyResult = 'unmapped';
    let taskId: string | null = null;
    let mapping: Mapping | undefined;
    let created = false;

    await runTx(async (tx) => {
      const [existingTask] = prev?.taskId
        ? await tx.select().from(tasks).where(and(eq(tasks.id, prev.taskId), isNull(tasks.deletedAt)))
        : [];
      mapping = mappings.find((m) => mappingMatches(m, t))
        ?? (existingTask ? mappings.find((m) => m.targetListId === existingTask.listId) : undefined);

      const statusIdFor = async (listId: string) => {
        const target = t.status ? Object.entries(mapping?.statusMap ?? {}).find(([k]) => k.toLowerCase() === t.status!.toLowerCase())?.[1] : undefined;
        if (!target) return undefined;
        const valid = await statusesForList(tx, listId);
        return valid.some((s) => s.id === target) ? target : undefined;
      };

      if (existingTask) {
        taskId = existingTask.id;
        const patch: { name?: string; statusId?: string; priority?: number | null } = {};
        if (t.subject !== prevSubject && t.subject !== existingTask.name) patch.name = t.subject.slice(0, 500);
        // only an actual status change in the ticket moves the task (manual moves on our side stick otherwise)
        if (t.status !== prevStatus) {
          const s = await statusIdFor(existingTask.listId);
          if (s && s !== existingTask.statusId) patch.statusId = s;
        }
        if ((t.priority ?? null) !== ((prevSnap?.priority as string | undefined) ?? null)) {
          const p = mapPriority(t.priority);
          if (p !== existingTask.priority) patch.priority = p;
        }
        if (Object.keys(patch).length) await updateTask(tx, existingTask, patch, { actorId: actor });
        result = 'updated';
      } else if (mapping && mappings.find((m) => mappingMatches(m, t)) === mapping) {
        const [list] = await tx.select({ id: lists.id, archivedAt: lists.archivedAt }).from(lists).where(eq(lists.id, mapping.targetListId));
        if (list && !list.archivedAt) {
          const link = ninjaTicketUrl(this.region, t.id);
          const desc = `${t.description ? `${stripHtml(t.description)}\n\n` : ''}NinjaOne ticket #${t.id}: ${link}`;
          const task = await createTask(tx, {
            listId: list.id,
            name: t.subject.slice(0, 500),
            description: plainToRichText(desc),
            statusId: await statusIdFor(list.id),
            priority: mapPriority(t.priority),
          }, { actorId: actor, source: 'ninjaone' });
          taskId = task.id;
          created = true;
          result = 'created';
        }
      }

      if (taskId && mapping && Object.keys(mapping.fieldMap).length) {
        const fieldIds = Object.values(mapping.fieldMap);
        const valid = new Set((await tx.select({ id: customFields.id }).from(customFields).where(inArray(customFields.id, fieldIds))).map((f) => f.id));
        for (const [path, fieldId] of Object.entries(mapping.fieldMap)) {
          if (!valid.has(fieldId)) continue;
          const value = readPath(t.raw, path);
          await tx.insert(taskFieldValues).values({ taskId, fieldId, value: value as never, updatedBy: actor })
            .onConflictDoUpdate({ target: [taskFieldValues.taskId, taskFieldValues.fieldId], set: { value: value as never, updatedBy: actor, updatedAt: new Date() } });
        }
      }

      const snapshot = { ...t.raw, __status: t.status, __subject: t.subject };
      await tx.insert(ninjaTickets).values({ ticketId: t.id, boardId: t.boardId, taskId, snapshot, snapshotHash: hash, lastPolledAt: new Date() })
        .onConflictDoUpdate({ target: ninjaTickets.ticketId, set: { boardId: t.boardId, taskId, snapshot, snapshotHash: hash, lastPolledAt: new Date() } });

      if (taskId) {
        emit('external.event', {
          source: 'ninjaone', event: created ? 'ticket_created' : 'ticket_updated', taskId,
          data: { ticketId: t.id, status: t.status, url: ninjaTicketUrl(this.region, t.id) },
        });
      }
    });

    // comments run in their own transactions after the task write committed (addComment opens one)
    if (taskId && mapping?.syncComments) {
      try {
        await this.syncComments(t.id, taskId, actor, client, created);
      } catch (err) {
        log.warn({ ticketId: t.id, error: err instanceof Error ? err.message : String(err) }, 'ninjaone comment sync failed');
        // force a retry of this ticket on the next run
        await db.update(ninjaTickets).set({ snapshotHash: 'retry-comments' }).where(eq(ninjaTickets.ticketId, t.id));
      }
    }
    return result;
  }

  private async syncComments(ticketId: number, taskId: string, actor: string, client: NinjaClient, backfill: boolean) {
    const entries = (await client.getLogEntries(ticketId)).filter(isPublicComment);
    if (!entries.length) return;
    const keys = entries.map((e) => `ninjaone:${e.id}`);
    const have = new Set((await db.select({ k: comments.sourceExternal }).from(comments).where(inArray(comments.sourceExternal, keys))).map((r) => r.k));
    let last: string | null = null;
    for (const e of entries) {
      const key = `ninjaone:${e.id}`;
      last = String(e.id);
      if (have.has(key)) continue;
      const text = e.body?.trim() ? e.body : stripHtml(e.htmlBody ?? '');
      try {
        await addComment({ kind: 'task', id: taskId }, actor, plainToRichText(text), null, { sourceExternal: key, createdAt: toDate(e.createTime), silent: backfill });
      } catch (err) {
        const e = err as { code?: string; cause?: { code?: string } };
        if (e.code !== '23505' && e.cause?.code !== '23505') throw err; // raced with another run: already there
      }
    }
    if (last) await db.update(ninjaTickets).set({ lastLogEntryId: last }).where(eq(ninjaTickets.ticketId, ticketId));
  }
}

/** Values seen in mirrored tickets over the last 7 days (for the "delta board coverage" warning). */
export async function recentlySeenValues() {
  const rows = await db.execute<{ status: string | null; priority: string | null; org: string | null; form: string | null }>(sql`
    select snapshot->>'__status' as status, snapshot->>'priority' as priority,
      coalesce(snapshot->>'clientId', snapshot->>'organizationId', snapshot->'organization'->>'id') as org,
      coalesce(snapshot->>'ticketFormId', snapshot->'ticketForm'->>'id', snapshot->'form'->>'id') as form
    from ninja_tickets where last_polled_at > now() - interval '7 days'`);
  const set = (k: 'status' | 'priority' | 'org' | 'form') => [...new Set(rows.map((r) => r[k]).filter((v): v is string => !!v).map((v) => v.toLowerCase()))];
  return { statuses: set('status'), priorities: set('priority'), orgIds: set('org'), formIds: set('form') };
}
