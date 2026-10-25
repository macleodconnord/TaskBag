import { createHash } from 'node:crypto';
import { and, eq, inArray } from 'drizzle-orm';
import { db, type Tx } from '../../db/client';
import { externalIds, importIssues, importRuns } from '../../db/schema';
import { log } from '../../lib/log';
import type { ClickUpApi, ClientStats } from './clickup/client';
import type { FieldPlan } from './stages/fields';
import type { HierarchyPlan } from './stages/hierarchy';

export const SOURCE = 'clickup';

export const STAGES = [
  'users', 'hierarchy', 'fields', 'tasks', 'relations', 'activity', 'docs', 'views', 'permissions', 'validation',
] as const;
export type Stage = (typeof STAGES)[number];
export const STAGE_LABELS: Record<Stage, string> = {
  users: 'Users & groups',
  hierarchy: 'Spaces, folders, lists & statuses',
  fields: 'Custom fields',
  tasks: 'Tasks, subtasks, checklists & tags',
  relations: 'Subtask parents, dependencies & links',
  activity: 'Comments & attachments',
  docs: 'Docs',
  views: 'Views',
  permissions: 'Sharing & permissions',
  validation: 'Validation',
};

export type RunMode = 'dry_run' | 'full' | 'delta';
export type RunRow = typeof importRuns.$inferSelect;

export interface RunOptions {
  includeArchived: boolean;
  /** comments + attachments cost ~2 API calls per task; a dry run may skip them */
  includeActivity: boolean;
  /** download attachment files (off: count only) */
  downloadAttachments: boolean;
  includeDocs: boolean;
  includeViews: boolean;
  includePermissions: boolean;
}
export const DEFAULT_OPTIONS: RunOptions = {
  includeArchived: true, includeActivity: true, downloadAttachments: true, includeDocs: true, includeViews: true, includePermissions: true,
};

export interface Pending {
  /** [childExt, parentExt] */
  parents: Array<[string, string]>;
  /** [waitingExt, blockingExt] */
  deps: Array<[string, string]>;
  links: Array<[string, string]>;
  /** relationship field values: task ext, field ext, target task exts */
  rels: Array<{ task: string; field: string; targets: string[] }>;
}

export interface ValidationResult {
  at: string;
  lists: Array<{ listExt: string; name: string; clickup: number; ours: number; ok: boolean }>;
  fields: { checked: number; mismatches: Array<{ task: string; field: string; expected: unknown; actual: unknown }> };
  attachments: { checked: number; mismatches: Array<{ attachment: string; filename: string; problem: string }> };
  ok: boolean;
}

export interface RunCursor {
  options?: RunOptions;
  /** stages completed in this run */
  done?: Stage[];
  stage?: Stage | null;
  /** stage-specific resume position */
  pos?: Record<string, number>;
  awaitingUserMapping?: boolean;
  progress?: { stage: Stage | null; done: number; total: number; label?: string };
  pending?: Pending;
  validation?: ValidationResult;
  client?: ClientStats;
  dropped?: Record<string, number>;
  workspaceName?: string;
  /** custom field placements decided in the fields stage */
  fieldPlan?: FieldPlan;
}

export type StatKind = 'seen' | 'created' | 'updated' | 'unchanged' | 'skipped' | 'failed';

export class ControlSignal extends Error {
  constructor(public kind: 'pause' | 'cancel') {
    super(kind);
  }
}

export const checksum = (v: unknown) => createHash('sha1').update(JSON.stringify(v)).digest('hex');

/**
 * Per-run state shared by the stages: mode, ClickUp client, stats, issues, the external-id map,
 * the resume cursor and pause/cancel control.
 */
export class ImportContext {
  readonly dry: boolean;
  stats: Record<string, Record<string, number>>;
  cursor: RunCursor;
  plan: HierarchyPlan | null = null;
  /** ClickUp user id → our user id (null = skipped/unmapped) */
  users = new Map<string, string | null>();
  systemUserId!: string;
  workspaceId!: string;
  /** dry runs keep the tasks they saw in memory for the activity stage */
  dryTaskIds: string[] = [];
  control: 'pause' | 'cancel' | null = null;

  private idCache = new Map<string, Map<string, { id: string; checksum: string | null }>>();
  private issueBuf: Array<typeof importIssues.$inferInsert> = [];
  private issueKeys = new Set<string>();
  private lastSave = 0;

  constructor(public run: RunRow, public api: ClickUpApi) {
    this.dry = run.mode === 'dry_run';
    this.stats = structuredClone(run.stats ?? {});
    this.cursor = structuredClone((run.cursor ?? {}) as RunCursor);
    this.cursor.options = { ...DEFAULT_OPTIONS, ...(this.cursor.options ?? {}) };
    this.cursor.done ??= [];
    this.cursor.pos ??= {};
    this.cursor.pending ??= { parents: [], deps: [], links: [], rels: [] };
    this.cursor.dropped ??= {};
  }

  get options(): RunOptions {
    return this.cursor.options!;
  }
  get mode(): RunMode {
    return this.run.mode;
  }
  get since(): Date | null {
    return this.run.mode === 'delta' ? this.run.since : null;
  }

  stat(entity: string, kind: StatKind, n = 1) {
    const e = (this.stats[entity] ??= { seen: 0, created: 0, updated: 0, unchanged: 0, skipped: 0, failed: 0 });
    e[kind] = (e[kind] ?? 0) + n;
  }

  dropped(what: string, n = 1) {
    this.cursor.dropped![what] = (this.cursor.dropped![what] ?? 0) + n;
  }

  /** Record a report issue (deduplicated per run). */
  issue(severity: 'info' | 'warn' | 'error', entity: string, externalId: string | null, message: string) {
    const key = `${severity}|${entity}|${externalId}|${message}`;
    if (this.issueKeys.has(key)) return;
    this.issueKeys.add(key);
    this.issueBuf.push({ importRunId: this.run.id, severity, entity, externalId, message: message.slice(0, 2000) });
  }

  async loadIssueKeys() {
    const rows = await db.select().from(importIssues).where(eq(importIssues.importRunId, this.run.id));
    for (const r of rows) this.issueKeys.add(`${r.severity}|${r.entity}|${r.externalId}|${r.message}`);
  }

  async flushIssues() {
    if (!this.issueBuf.length) return;
    const batch = this.issueBuf.splice(0);
    for (let i = 0; i < batch.length; i += 500) await db.insert(importIssues).values(batch.slice(i, i + 500));
  }

  // ── external ids ──

  private async entityMap(entity: string) {
    let m = this.idCache.get(entity);
    if (!m) {
      m = new Map();
      const rows = await db.select().from(externalIds).where(and(eq(externalIds.source, SOURCE), eq(externalIds.entity, entity)));
      for (const r of rows) m.set(r.externalId, { id: r.internalId, checksum: r.checksum });
      this.idCache.set(entity, m);
    }
    return m;
  }

  async lookup(entity: string, ext: string) {
    return (await this.entityMap(entity)).get(ext) ?? null;
  }
  async idOf(entity: string, ext: string | null | undefined): Promise<string | null> {
    if (!ext) return null;
    return (await this.lookup(entity, ext))?.id ?? null;
  }
  async allOf(entity: string) {
    return this.entityMap(entity);
  }

  /** Upsert an external id mapping (touching it for this run). */
  async link(tx: Tx, entity: string, ext: string, internalId: string, sum: string | null) {
    if (this.dry) return;
    await tx.insert(externalIds).values({ source: SOURCE, entity, externalId: ext, internalId, importRunId: this.run.id, checksum: sum })
      .onConflictDoUpdate({ target: [externalIds.source, externalIds.entity, externalIds.externalId], set: { internalId, importRunId: this.run.id, checksum: sum } });
    (await this.entityMap(entity)).set(ext, { id: internalId, checksum: sum });
  }

  async unlink(tx: Tx, entity: string, ext: string) {
    if (this.dry) return;
    await tx.delete(externalIds).where(and(eq(externalIds.source, SOURCE), eq(externalIds.entity, entity), eq(externalIds.externalId, ext)));
    (await this.entityMap(entity)).delete(ext);
  }

  /** Mark unchanged mappings as seen by this run (the activity stage works off these). */
  async touch(entity: string, exts: string[]) {
    if (this.dry || !exts.length) return;
    for (let i = 0; i < exts.length; i += 1000) {
      await db.update(externalIds).set({ importRunId: this.run.id })
        .where(and(eq(externalIds.source, SOURCE), eq(externalIds.entity, entity), inArray(externalIds.externalId, exts.slice(i, i + 1000))));
    }
  }

  /** Author for imported content: the mapped user, else the ClickUp import system user. */
  author(cuUserId: string | number | null | undefined): string {
    if (cuUserId === null || cuUserId === undefined) return this.systemUserId;
    return this.users.get(String(cuUserId)) ?? this.systemUserId;
  }
  /** Mapped user or null (and a warning once per unknown user). */
  user(cuUser: { id: string; username?: string | null; email?: string | null } | null | undefined, context: string): string | null {
    if (!cuUser) return null;
    const id = String(cuUser.id);
    if (this.users.has(id)) {
      const u = this.users.get(id)!;
      if (!u) this.issue('warn', 'user', id, `${cuUser.username ?? cuUser.email ?? id} is not mapped (skipped); dropped from ${context}`);
      return u;
    }
    this.issue('warn', 'user', id, `${cuUser.username ?? cuUser.email ?? id} is not a workspace member; dropped from ${context}`);
    return null;
  }

  // ── progress, checkpoints, control ──

  progress(done: number, total: number, label?: string) {
    this.cursor.progress = { stage: this.cursor.stage ?? null, done, total, label };
  }

  /** Persist stats/cursor (throttled unless forced) and honour pause/cancel requests. */
  async checkpoint(force = false) {
    if (this.control) {
      await this.save(true);
      throw new ControlSignal(this.control);
    }
    if (force || Date.now() - this.lastSave > 2000) await this.save(true);
  }

  async save(_force = true) {
    this.lastSave = Date.now();
    this.cursor.client = this.api.stats();
    await this.flushIssues();
    try {
      await db.update(importRuns).set({ stats: this.stats, cursor: this.cursor as Record<string, unknown> }).where(eq(importRuns.id, this.run.id));
    } catch (err) {
      log.error({ err }, 'import: could not save checkpoint');
    }
  }
}
