import { evaluateFormula, FIELD_TYPES, validateFormula, type FieldType } from '@app/shared';
import { and, asc, eq, inArray, isNull, or, sql, type SQL } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Tx } from '../../db/client';
import { customFields, folders, lists, taskFieldValues, tasks, users } from '../../db/schema';
import type { AccessContext } from '../../lib/access';
import { NotFound, Validation } from '../../lib/errors';
import type { TaskRow } from '../tasks/service';

export type FieldRow = typeof customFields.$inferSelect;
export type FieldScopeType = 'space' | 'folder' | 'list';

/*
 * Value shapes (task_field_values.value), matching modules/tasks/filter.ts:
 *   text/url/email/phone: string · number/currency/rating/progress: number · dropdown: optionId
 *   labels: optionId[] · date: ISO string · checkbox: boolean · user: userId[] · relationship: taskId[]
 *   formula: never stored, computed on read.
 */

// ───────────── config ─────────────

const optionSchema = z.object({
  id: z.string().min(1).max(64).optional(),
  name: z.string().trim().min(1).max(100),
  color: z.string().max(20).optional(),
});
const configSchemas: Record<FieldType, z.ZodType<Record<string, unknown>>> = {
  text: z.object({}),
  url: z.object({}),
  email: z.object({}),
  phone: z.object({}),
  number: z.object({ precision: z.number().int().min(0).max(6).optional() }),
  currency: z.object({ currency: z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/).default('USD'), precision: z.number().int().min(0).max(4).default(2) }),
  dropdown: z.object({ options: z.array(optionSchema).max(200).default([]) }),
  labels: z.object({ options: z.array(optionSchema).max(200).default([]) }),
  date: z.object({ includeTime: z.boolean().optional() }),
  checkbox: z.object({}),
  user: z.object({ multiple: z.boolean().default(true) }),
  rating: z.object({ max: z.number().int().min(1).max(10).default(5) }),
  progress: z.object({}),
  relationship: z.object({ targetListId: z.string().uuid().nullable().optional() }),
  formula: z.object({ expression: z.string().trim().min(1).max(2000), precision: z.number().int().min(0).max(6).optional() }),
};

const OPTION_COLORS = ['#ef4444', '#f97316', '#eab308', '#22c55e', '#14b8a6', '#3b82f6', '#6366f1', '#a855f7', '#ec4899', '#64748b'];

/** Validate and normalize a field config; option ids are generated for new options. */
export function normalizeConfig(type: FieldType, raw: unknown): Record<string, unknown> {
  const r = configSchemas[type].safeParse(raw ?? {});
  if (!r.success) throw new Validation(`Invalid ${type} field settings: ${r.error.issues[0]?.message ?? ''}`);
  const cfg = { ...r.data };
  if (type === 'dropdown' || type === 'labels') {
    const opts = (cfg.options as Array<z.infer<typeof optionSchema>>).map((o, i) => ({
      id: o.id ?? randomUUID(), name: o.name, color: o.color ?? OPTION_COLORS[i % OPTION_COLORS.length],
    }));
    if (new Set(opts.map((o) => o.id)).size !== opts.length) throw new Validation('Duplicate option ids');
    cfg.options = opts;
  }
  return cfg;
}

export const createFieldSchema = z.object({
  name: z.string().trim().min(1).max(100),
  type: z.enum(FIELD_TYPES),
  config: z.record(z.string(), z.unknown()).optional(),
  scopeType: z.enum(['space', 'folder', 'list']),
  scopeId: z.string().uuid(),
  required: z.boolean().optional(),
});
export const updateFieldSchema = z.object({
  name: z.string().trim().min(1).max(100).optional(),
  config: z.record(z.string(), z.unknown()).optional(),
  required: z.boolean().optional(),
  archived: z.boolean().optional(),
});

// ───────────── scopes ─────────────

/** Space/folder/list chain for each list. */
export async function listChains(tx: Tx, listIds: string[]) {
  if (!listIds.length) return new Map<string, { spaceId: string; folderId: string | null }>();
  const rows = await tx.select({ id: lists.id, spaceId: lists.spaceId, folderId: lists.folderId }).from(lists).where(inArray(lists.id, [...new Set(listIds)]));
  return new Map(rows.map((r) => [r.id, { spaceId: r.spaceId, folderId: r.folderId }]));
}

const scopeCond = (type: FieldScopeType, ids: string[]): SQL | undefined =>
  ids.length ? and(eq(customFields.scopeType, type), inArray(customFields.scopeId, ids)) : undefined;

const SCOPE_RANK: Record<FieldScopeType, number> = { space: 0, folder: 1, list: 2 };
export const sortFields = (fs: FieldRow[]) =>
  [...fs].sort((a, b) => SCOPE_RANK[a.scopeType] - SCOPE_RANK[b.scopeType] || a.position - b.position || a.name.localeCompare(b.name));

/** Fields applying to each list (its own + its folder's + its space's), archived excluded. */
export async function fieldsForLists(tx: Tx, listIds: string[]): Promise<Map<string, FieldRow[]>> {
  const chains = await listChains(tx, listIds);
  const out = new Map<string, FieldRow[]>();
  if (!chains.size) return out;
  const spaceIds = [...new Set([...chains.values()].map((c) => c.spaceId))];
  const folderIds = [...new Set([...chains.values()].map((c) => c.folderId).filter((f): f is string => !!f))];
  const conds = [scopeCond('list', [...chains.keys()]), scopeCond('folder', folderIds), scopeCond('space', spaceIds)].filter(Boolean) as SQL[];
  const rows = await tx.select().from(customFields).where(and(isNull(customFields.archivedAt), or(...conds)));
  for (const [listId, c] of chains) {
    out.set(listId, sortFields(rows.filter((f) =>
      (f.scopeType === 'list' && f.scopeId === listId) || (f.scopeType === 'folder' && f.scopeId === c.folderId) || (f.scopeType === 'space' && f.scopeId === c.spaceId))));
  }
  return out;
}

export async function fieldsForList(tx: Tx, listId: string) {
  return (await fieldsForLists(tx, [listId])).get(listId) ?? [];
}

/** Does `field` apply to tasks in `listId`? */
export async function fieldAppliesToList(tx: Tx, field: FieldRow, listId: string) {
  return (await fieldsForList(tx, listId)).some((f) => f.id === field.id);
}

/**
 * Fields for a view scope: the scope's own + ancestors' fields, plus (for spaces/folders) fields defined
 * on scopes beneath it, so table columns exist for every task the view can show. `everything`: all fields
 * whose scope the viewer can see.
 */
export async function fieldsForScope(tx: Tx, access: AccessContext, scopeType: 'space' | 'folder' | 'list' | 'everything', scopeId: string | undefined, opts: { exact?: boolean; includeArchived?: boolean } = {}) {
  const arch = opts.includeArchived ? undefined : isNull(customFields.archivedAt);
  if (scopeType === 'everything') {
    const rows = await tx.select().from(customFields).where(and(arch, scopeExists));
    return filterVisibleFields(tx, access, rows);
  }
  if (!scopeId) throw new Validation('scopeId is required');
  if (opts.exact) {
    return sortFields(await tx.select().from(customFields).where(and(arch, eq(customFields.scopeType, scopeType), eq(customFields.scopeId, scopeId))));
  }
  let conds: Array<SQL | undefined> = [];
  if (scopeType === 'list') {
    const c = (await listChains(tx, [scopeId])).get(scopeId);
    if (!c) throw new NotFound('List not found');
    conds = [scopeCond('list', [scopeId]), scopeCond('folder', c.folderId ? [c.folderId] : []), scopeCond('space', [c.spaceId])];
  } else if (scopeType === 'folder') {
    const [f] = await tx.select().from(folders).where(eq(folders.id, scopeId));
    if (!f) throw new NotFound('Folder not found');
    const listIds = (await tx.select({ id: lists.id }).from(lists).where(and(eq(lists.folderId, f.id), isNull(lists.archivedAt)))).map((r) => r.id);
    conds = [scopeCond('folder', [f.id]), scopeCond('space', [f.spaceId]), scopeCond('list', listIds)];
  } else {
    const fIds = (await tx.select({ id: folders.id }).from(folders).where(and(eq(folders.spaceId, scopeId), isNull(folders.archivedAt)))).map((r) => r.id);
    const listIds = (await tx.select({ id: lists.id }).from(lists).where(and(eq(lists.spaceId, scopeId), isNull(lists.archivedAt)))).map((r) => r.id);
    conds = [scopeCond('space', [scopeId]), scopeCond('folder', fIds), scopeCond('list', listIds)];
  }
  const rows = await tx.select().from(customFields).where(and(arch, or(...(conds.filter(Boolean) as SQL[]))));
  return filterVisibleFields(tx, access, rows);
}

/** The field's scope object still exists (scopes are polymorphic, so there is no FK). */
const scopeExists = sql`(case ${customFields.scopeType}
  when 'space' then exists (select 1 from spaces where id = ${customFields.scopeId})
  when 'folder' then exists (select 1 from folders where id = ${customFields.scopeId})
  else exists (select 1 from lists where id = ${customFields.scopeId}) end)`;

/** Delete fields (and, by cascade, their values) whose space/folder/list was deleted. */
export async function purgeOrphanFields(tx: Tx) {
  const rows = await tx.delete(customFields).where(sql`not ${scopeExists}`).returning({ id: customFields.id });
  return rows.length;
}

/** Keep fields whose defining scope object the viewer can see. */
async function filterVisibleFields(tx: Tx, access: AccessContext, rows: FieldRow[]) {
  if (access.isAdmin) return sortFields(rows);
  const out: FieldRow[] = [];
  const cache = new Map<string, boolean>();
  for (const f of rows) {
    const k = `${f.scopeType}:${f.scopeId}`;
    if (!cache.has(k)) cache.set(k, (await access.levelOf(f.scopeType, f.scopeId, tx)) !== 'none');
    if (cache.get(k)) out.push(f);
  }
  return sortFields(out);
}

/** Public shape of a field definition. */
export const fieldDto = (f: FieldRow) => ({
  id: f.id, name: f.name, type: f.type as FieldType, config: f.config, scopeType: f.scopeType, scopeId: f.scopeId,
  required: f.required, position: f.position, archivedAt: f.archivedAt,
});

/** Names usable in a formula defined at a scope (fields applying there, other than itself). */
export async function formulaNamesForScope(tx: Tx, scopeType: FieldScopeType, scopeId: string, selfId?: string) {
  let rows: FieldRow[];
  if (scopeType === 'list') rows = await fieldsForList(tx, scopeId);
  else if (scopeType === 'folder') {
    const [f] = await tx.select().from(folders).where(eq(folders.id, scopeId));
    rows = f ? await tx.select().from(customFields).where(and(isNull(customFields.archivedAt), or(
      and(eq(customFields.scopeType, 'folder'), eq(customFields.scopeId, f.id)),
      and(eq(customFields.scopeType, 'space'), eq(customFields.scopeId, f.spaceId)),
    ))) : [];
  } else rows = await tx.select().from(customFields).where(and(isNull(customFields.archivedAt), eq(customFields.scopeType, 'space'), eq(customFields.scopeId, scopeId)));
  return rows.filter((f) => f.id !== selfId).map((f) => f.name);
}

export function checkFormula(expression: string, names: string[]) {
  const err = validateFormula(expression, [...names, 'due_date', 'start_date', 'time_estimate']);
  if (err) throw new Validation(`Formula: ${err}`);
}

// ───────────── values ─────────────

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Validate a value for a field; returns the normalized value, or null to clear it.
 * Throws Validation with a readable message.
 */
export async function normalizeValue(tx: Tx, field: FieldRow, value: unknown, access: AccessContext): Promise<unknown> {
  const type = field.type as FieldType;
  const cfg = field.config ?? {};
  const empty = value === null || value === undefined || value === '' || (Array.isArray(value) && value.length === 0);
  if (type === 'formula') throw new Validation('Formula fields are computed and cannot be edited');
  if (empty) return null;
  const bad = (msg: string): never => { throw new Validation(`${field.name}: ${msg}`); };
  const num = () => {
    const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
    if (typeof n !== 'number' || !Number.isFinite(n)) bad('must be a number');
    return n as number;
  };
  const ids = () => {
    if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) bad('must be a list of ids');
    return [...new Set(value as string[])];
  };
  switch (type) {
    case 'text': case 'phone': {
      if (typeof value !== 'string') bad('must be text');
      const s = (value as string).trim();
      if (s.length > 5000) bad('is too long');
      if (type === 'phone' && !/^[+()\d\s.\-x]{3,40}$/i.test(s)) bad('is not a valid phone number');
      return s || null;
    }
    case 'url': {
      if (typeof value !== 'string') bad('must be a URL');
      let s = (value as string).trim();
      if (!/^[a-z][a-z0-9+.-]*:/i.test(s)) s = `https://${s}`;
      try {
        const u = new URL(s);
        if (!['http:', 'https:', 'mailto:', 'ftp:'].includes(u.protocol)) bad('must be an http(s) URL');
      } catch { bad('is not a valid URL'); }
      if (s.length > 2000) bad('is too long');
      return s;
    }
    case 'email': {
      if (typeof value !== 'string' || !EMAIL.test(value.trim())) bad('is not a valid email address');
      return (value as string).trim();
    }
    case 'number': case 'currency': return num();
    case 'rating': {
      const n = num();
      const max = Number(cfg.max ?? 5);
      if (!Number.isInteger(n) || n < 0 || n > max) bad(`must be a whole number from 0 to ${max}`);
      return n === 0 ? null : n;
    }
    case 'progress': {
      const n = num();
      if (n < 0 || n > 100) bad('must be between 0 and 100');
      return Math.round(n * 100) / 100;
    }
    case 'checkbox':
      if (typeof value !== 'boolean') bad('must be true or false');
      return value;
    case 'date': {
      if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) bad('must be a date');
      // a bare yyyy-mm-dd means that calendar day: store at noon UTC so it shows on the same day everywhere
      const v = /^\d{4}-\d{2}-\d{2}$/.test(value as string) ? `${value}T12:00:00.000Z` : (value as string);
      return new Date(v).toISOString();
    }
    case 'dropdown': {
      if (typeof value !== 'string') bad('must be an option id');
      const opts = (cfg.options as Array<{ id: string }> | undefined) ?? [];
      if (!opts.some((o) => o.id === value)) bad('unknown option');
      return value;
    }
    case 'labels': {
      const v = ids();
      const opts = new Set(((cfg.options as Array<{ id: string }> | undefined) ?? []).map((o) => o.id));
      if (v.some((x) => !opts.has(x))) bad('unknown option');
      return v;
    }
    case 'user': {
      const v = ids();
      if (cfg.multiple === false && v.length > 1) bad('only one person allowed');
      if (v.some((x) => !/^[0-9a-f-]{36}$/i.test(x))) bad('bad user id');
      const found = await tx.select({ id: users.id }).from(users).where(and(inArray(users.id, v), eq(users.isActive, true)));
      if (found.length !== v.length) bad('unknown user');
      return v;
    }
    case 'relationship': {
      const v = ids();
      if (v.length > 100) bad('too many tasks');
      if (v.some((x) => !/^[0-9a-f-]{36}$/i.test(x))) bad('bad task id');
      const found = await tx.select({ id: tasks.id, listId: tasks.listId }).from(tasks)
        .where(and(inArray(tasks.id, v), isNull(tasks.deletedAt), await access.filter(tasks.aclScopeId)));
      if (found.length !== v.length) bad('task not found');
      const target = cfg.targetListId as string | undefined | null;
      if (target && found.some((t) => t.listId !== target)) bad('tasks must come from the linked list');
      return v;
    }
  }
  return bad('unsupported field type');
}

// ───────────── reading values (with formulas) ─────────────

/** Value of a field as a formula sees it. */
function formulaInput(f: FieldRow, v: unknown): unknown {
  if (v == null) return null;
  if (f.type === 'dropdown') return ((f.config.options as Array<{ id: string; name: string }> | undefined) ?? []).find((o) => o.id === v)?.name ?? null;
  return v;
}

/** Compute formula values for one task, given its applicable fields and stored values. */
export function computeFormulas(task: Pick<TaskRow, 'dueAt' | 'startAt' | 'timeEstimateMin'>, fields: FieldRow[], stored: Map<string, unknown>) {
  const out = new Map<string, unknown>();
  const byName = new Map<string, FieldRow>();
  for (const f of fields) if (!byName.has(f.name.toLowerCase())) byName.set(f.name.toLowerCase(), f);
  const visiting = new Set<string>();
  const valueOf = (f: FieldRow): unknown => {
    if (f.type !== 'formula') return formulaInput(f, stored.get(f.id) ?? null);
    if (out.has(f.id)) return out.get(f.id);
    if (visiting.has(f.id)) return null; // cycle
    visiting.add(f.id);
    const expr = String(f.config.expression ?? '');
    let v = evaluateFormula(expr, {
      resolve: (name) => {
        if (name === 'due_date') return task.dueAt?.toISOString() ?? null;
        if (name === 'start_date') return task.startAt?.toISOString() ?? null;
        if (name === 'time_estimate') return task.timeEstimateMin ?? null;
        const ref = byName.get(name);
        return ref ? valueOf(ref) : undefined;
      },
    });
    const precision = f.config.precision;
    if (typeof v === 'number' && typeof precision === 'number') v = Math.round(v * 10 ** precision) / 10 ** precision;
    visiting.delete(f.id);
    out.set(f.id, v);
    return v;
  };
  for (const f of fields) if (f.type === 'formula') valueOf(f);
  return out;
}

/**
 * Field values for tasks: Record<fieldId, value> per task, only for fields that apply to the task's
 * list. Relationship values are filtered to tasks the viewer can see. Formulas are computed.
 */
export async function valuesForTasks(tx: Tx, rows: TaskRow[], access: AccessContext) {
  const result = new Map<string, Record<string, unknown>>();
  if (!rows.length) return { result, fieldsByList: new Map<string, FieldRow[]>() };
  const fieldsByList = await fieldsForLists(tx, rows.map((r) => r.listId));
  const anyFields = [...fieldsByList.values()].some((f) => f.length);
  const stored = anyFields
    ? await tx.select({ taskId: taskFieldValues.taskId, fieldId: taskFieldValues.fieldId, value: taskFieldValues.value })
      .from(taskFieldValues).where(inArray(taskFieldValues.taskId, rows.map((r) => r.id)))
    : [];
  const byTask = new Map<string, Map<string, unknown>>();
  for (const s of stored) {
    const m = byTask.get(s.taskId) ?? new Map<string, unknown>();
    m.set(s.fieldId, s.value);
    byTask.set(s.taskId, m);
  }
  // relationship visibility
  const relFieldIds = new Set([...fieldsByList.values()].flat().filter((f) => f.type === 'relationship').map((f) => f.id));
  const relIds = new Set<string>();
  for (const s of stored) if (relFieldIds.has(s.fieldId) && Array.isArray(s.value)) for (const id of s.value) relIds.add(String(id));
  const visibleRel = new Set<string>();
  if (relIds.size) {
    const vis = await tx.select({ id: tasks.id }).from(tasks)
      .where(and(inArray(tasks.id, [...relIds]), isNull(tasks.deletedAt), await access.filter(tasks.aclScopeId)));
    vis.forEach((v) => visibleRel.add(v.id));
  }
  for (const r of rows) {
    const fields = fieldsByList.get(r.listId) ?? [];
    const vals = byTask.get(r.id) ?? new Map<string, unknown>();
    const rec: Record<string, unknown> = {};
    for (const f of fields) {
      if (f.type === 'formula') continue;
      let v = vals.get(f.id);
      if (v === undefined || v === null) continue;
      if (f.type === 'relationship' && Array.isArray(v)) v = v.filter((id) => visibleRel.has(String(id)));
      rec[f.id] = v;
    }
    if (fields.some((f) => f.type === 'formula')) {
      for (const [id, v] of computeFormulas(r, fields, vals)) if (v !== null) rec[id] = v;
    }
    result.set(r.id, rec);
  }
  return { result, fieldsByList };
}

/** Write (or clear) one value. Caller checked edit on the task and normalized the value. */
export async function writeValue(tx: Tx, taskId: string, fieldId: string, value: unknown, actorId: string | null) {
  if (value === null) {
    await tx.delete(taskFieldValues).where(and(eq(taskFieldValues.taskId, taskId), eq(taskFieldValues.fieldId, fieldId)));
  } else {
    await tx.insert(taskFieldValues).values({ taskId, fieldId, value, updatedBy: actorId })
      .onConflictDoUpdate({ target: [taskFieldValues.taskId, taskFieldValues.fieldId], set: { value, updatedBy: actorId, updatedAt: new Date() } });
  }
  await tx.update(tasks).set({ updatedAt: new Date() }).where(eq(tasks.id, taskId));
}

export async function nextFieldPosition(tx: Tx, scopeType: FieldScopeType, scopeId: string) {
  const [{ n }] = await tx.select({ n: sql<number>`coalesce(max(${customFields.position}), -1)::int + 1` }).from(customFields)
    .where(and(eq(customFields.scopeType, scopeType), eq(customFields.scopeId, scopeId)));
  return n;
}

export const orderedFields = (tx: Tx, scopeType: FieldScopeType, scopeId: string) =>
  tx.select().from(customFields).where(and(eq(customFields.scopeType, scopeType), eq(customFields.scopeId, scopeId))).orderBy(asc(customFields.position));
