import { viewConfigSchema, type FilterCondition } from '@app/shared';
import { eq } from 'drizzle-orm';
import { views } from '../../../db/schema';
import { runTx } from '../../../lib/tx';
import type { CuLocation } from '../clickup/client';
import type { CuView } from '../clickup/schemas';
import { checksum, type ImportContext } from '../context';
import { placementExt, type FieldPlan } from './fields';

const VIEW_TYPES: Record<string, 'list' | 'board' | 'table' | 'calendar' | 'gantt'> = {
  list: 'list', board: 'board', table: 'table', calendar: 'calendar', gantt: 'gantt', timeline: 'gantt',
};
const DATE_FIELDS: Record<string, string> = {
  dueDate: 'due_at', startDate: 'start_at', dateCreated: 'created_at', dateUpdated: 'updated_at', dateClosed: 'completed_at', dateDone: 'completed_at',
};
const GROUPS: Record<string, string> = { status: 'status', assignee: 'assignee', priority: 'priority', tag: 'tag', dueDate: 'due', none: 'none' };
const OPS: Record<string, FilterCondition['op']> = {
  EQ: 'any_of', ANY: 'any_of', ALL: 'any_of', NOT: 'none_of', 'NOT ANY': 'none_of', 'NOT ALL': 'none_of',
  'IS SET': 'is_set', 'IS NOT SET': 'is_not_set', GT: 'gt', GTE: 'gte', LT: 'lt', LTE: 'lte',
};

interface Scope {
  type: 'everything' | 'space' | 'folder' | 'list';
  cuId: string | null;
  /** ClickUp ids of the space / folder this scope sits in (for field placements and statuses) */
  spaceExt: string | null;
  folderExt: string | null;
}

/** Translate one ClickUp view; returns the config and what could not be carried over. */
export async function translateView(ctx: ImportContext, fieldPlan: FieldPlan, v: CuView, scope: Scope) {
  const lossy: string[] = [];
  const cf = async (field: string) => {
    const id = field.slice(3);
    const e = fieldPlan[id];
    if (!e?.type) return null;
    const cands = [
      scope.type === 'list' && scope.cuId ? { scopeType: 'list' as const, cuScopeId: scope.cuId } : null,
      scope.folderExt ? { scopeType: 'folder' as const, cuScopeId: scope.folderExt } : null,
      scope.spaceExt ? { scopeType: 'space' as const, cuScopeId: scope.spaceExt } : null,
    ].filter((x) => !!x);
    for (const c of cands) {
      if (!e.placements.some((p) => p.scopeType === c.scopeType && p.cuScopeId === c.cuScopeId)) continue;
      const fid = await ctx.idOf('field', placementExt(id, c));
      return `cf:${fid ?? '00000000-0000-0000-0000-000000000000'}`;
    }
    return null;
  };
  const statusIds = async (names: string[]) => {
    const all = await ctx.allOf('status');
    const prefixes = scope.type === 'everything' ? [''] : [scope.spaceExt ? `space:${scope.spaceExt}:` : '', scope.type === 'list' ? `list:${scope.cuId}:` : ''].filter(Boolean);
    const out: string[] = [];
    for (const n of names) {
      for (const [ext, m] of all) if (ext.endsWith(`:${n.toLowerCase()}`) && prefixes.some((p) => ext.startsWith(p))) out.push(m.id);
    }
    return out;
  };
  const tagIds = async (names: string[]) => {
    const all = await ctx.allOf('tag');
    return [...all].filter(([ext]) => names.some((n) => ext.endsWith(`:${n.toLowerCase()}`)) && (!scope.spaceExt || ext.startsWith(`${scope.spaceExt}:`))).map(([, m]) => m.id);
  };

  // group by
  let groupBy = 'status';
  const g = v.grouping?.field;
  if (g) {
    if (GROUPS[g]) groupBy = GROUPS[g];
    else if (g.startsWith('cf_')) {
      const f = await cf(g);
      if (f) groupBy = f;
      else lossy.push(`group by ${g}`);
    } else lossy.push(`group by "${g}"`);
  }
  // sort
  const sort: Array<{ field: string; dir: 'asc' | 'desc' }> = [];
  for (const s of v.sorting?.fields ?? []) {
    const field = DATE_FIELDS[s.field] ?? (['name', 'priority', 'status'].includes(s.field) ? s.field : s.field.startsWith('cf_') ? await cf(s.field) : null);
    if (field) sort.push({ field, dir: (s.dir ?? 1) < 0 ? 'desc' : 'asc' });
    else lossy.push(`sort by "${s.field}"`);
  }
  // filters
  const conditions: FilterCondition[] = [];
  for (const f of v.filters?.fields ?? []) {
    const op = OPS[f.op.toUpperCase()];
    const values = (f.values ?? []).map((x) => (typeof x === 'object' && x && 'id' in x ? String((x as { id: unknown }).id) : String(x)));
    if (!op) { lossy.push(`filter ${f.field} ${f.op}`); continue; }
    const setOp = op === 'is_set' || op === 'is_not_set';
    if (f.field === 'assignee' || f.field === 'assignees') {
      const ids = values.map((x) => (x === 'me' ? 'me' : ctx.users.get(x) ?? null)).filter((x): x is string => !!x);
      if (setOp || ids.length) conditions.push({ field: 'assignee', op: setOp ? op : op === 'none_of' ? 'none_of' : 'any_of', value: setOp ? undefined : ids });
      else lossy.push('assignee filter (users not mapped)');
    } else if (f.field === 'priority') {
      const p = values.map(Number).filter((n) => n >= 1 && n <= 4);
      if (setOp || p.length) conditions.push({ field: 'priority', op: setOp ? op : op === 'none_of' ? 'none_of' : 'any_of', value: setOp ? undefined : p });
      else lossy.push('priority filter');
    } else if (f.field === 'status') {
      const ids = await statusIds(values);
      if (ids.length) conditions.push({ field: 'status', op: op === 'none_of' ? 'none_of' : 'any_of', value: ids });
      else lossy.push(`status filter (${values.join(', ')})`);
    } else if (f.field === 'tag' || f.field === 'tags') {
      const ids = await tagIds(values);
      if (setOp || ids.length) conditions.push({ field: 'tag', op: setOp ? op : op === 'none_of' ? 'none_of' : 'any_of', value: setOp ? undefined : ids });
      else lossy.push('tag filter');
    } else if (DATE_FIELDS[f.field] && setOp) {
      conditions.push({ field: DATE_FIELDS[f.field], op });
    } else if (f.field.startsWith('cf_')) {
      const field = await cf(f.field);
      if (!field) { lossy.push(`filter on custom field ${f.field}`); continue; }
      if (setOp) conditions.push({ field, op });
      else if (op === 'gt' || op === 'gte' || op === 'lt' || op === 'lte') conditions.push({ field, op, value: Number(values[0]) });
      else conditions.push({ field, op, value: values });
    } else {
      lossy.push(`filter on "${f.field}" (${f.op})`);
    }
  }
  if (v.filters?.search) conditions.push({ field: 'name', op: 'contains', value: v.filters.search });

  const columns: string[] = [];
  const columnWidths: Record<string, number> = {};
  for (const c of v.columns?.fields ?? []) {
    if (c.hidden) continue;
    const col = DATE_FIELDS[c.field] ?? (['assignee', 'priority', 'status', 'tag', 'name'].includes(c.field) ? c.field : c.field.startsWith('cf_') ? await cf(c.field) : null);
    if (!col) continue;
    columns.push(col);
    if (c.width) columnWidths[col] = c.width;
  }
  const config = viewConfigSchema.parse({
    filters: conditions.length ? { op: (v.filters?.op ?? 'AND').toUpperCase() === 'OR' ? 'or' : 'and', conditions } : undefined,
    groupBy, sort, columns, columnWidths,
    showSubtasks: (v.settings?.show_subtasks ?? 1) > 1,
    showClosed: !!v.filters?.show_closed,
    dateField: 'due_at',
  });
  return { config, lossy };
}

/** Stage 8: views where the type translates (list/board/table/calendar/gantt). */
export async function runViews(ctx: ImportContext, fieldPlan: FieldPlan) {
  if (!ctx.options.includeViews) return;
  const plan = ctx.plan!;
  const locs: Array<{ loc: CuLocation; scope: Scope }> = [
    { loc: { type: 'team', id: ctx.api.teamId }, scope: { type: 'everything', cuId: null, spaceExt: null, folderExt: null } },
    ...plan.spaces.map((s) => ({ loc: { type: 'space' as const, id: s.id }, scope: { type: 'space' as const, cuId: s.id, spaceExt: s.id, folderExt: null } })),
    ...plan.folders.map((f) => ({ loc: { type: 'folder' as const, id: f.cu.id }, scope: { type: 'folder' as const, cuId: f.cu.id, spaceExt: f.spaceExt, folderExt: f.cu.id } })),
    ...plan.lists.map((l) => ({ loc: { type: 'list' as const, id: l.cu.id }, scope: { type: 'list' as const, cuId: l.cu.id, spaceExt: l.spaceExt, folderExt: l.folderExt } })),
  ];
  for (let i = ctx.cursor.pos!.views ?? 0; i < locs.length; i++) {
    const { loc, scope } = locs[i];
    let list: CuView[] = [];
    try {
      list = await ctx.api.getViews(loc);
    } catch (err) {
      ctx.issue('warn', 'view', loc.id, `Views of ${loc.type} ${loc.id} could not be read: ${(err as Error).message}`);
    }
    for (const [pos, v] of list.entries()) {
      ctx.stat('view', 'seen');
      const type = VIEW_TYPES[v.type];
      if (!type) {
        ctx.stat('view', 'skipped');
        ctx.issue('info', 'view', v.id, `View "${v.name}" (${v.type}) has no equivalent here; not imported`);
        continue;
      }
      const { config, lossy } = await translateView(ctx, fieldPlan, v, scope);
      if (lossy.length) ctx.issue('warn', 'view', v.id, `View "${v.name}": could not carry over ${lossy.join('; ')}`);
      const scopeId = scope.type === 'everything' ? null : await ctx.idOf(scope.type, scope.cuId);
      const want = { name: v.name.slice(0, 100) || 'View', type, config, visibility: v.visibility === 'personal' ? 'personal' as const : 'shared' as const };
      const sum = checksum(want);
      const mapped = await ctx.lookup('view', v.id);
      if (ctx.dry) {
        ctx.stat('view', !mapped ? 'created' : mapped.checksum === sum ? 'unchanged' : 'updated');
        continue;
      }
      if (mapped && mapped.checksum === sum) {
        ctx.stat('view', 'unchanged');
        await ctx.touch('view', [v.id]);
        continue;
      }
      if (scope.type !== 'everything' && !scopeId) {
        ctx.stat('view', 'skipped');
        continue;
      }
      await runTx(async (tx) => {
        const [row] = mapped ? await tx.select({ id: views.id }).from(views).where(eq(views.id, mapped.id)) : [];
        let id = row?.id;
        if (id) {
          await tx.update(views).set(want).where(eq(views.id, id));
          ctx.stat('view', 'updated');
        } else {
          [{ id }] = await tx.insert(views).values({
            ...want, scopeType: scope.type, scopeId, ownerId: ctx.author(v.creator != null ? String(v.creator) : null), position: 100 + pos,
          }).returning({ id: views.id });
          ctx.stat('view', 'created');
        }
        await ctx.link(tx, 'view', v.id, id!, sum);
      });
    }
    ctx.cursor.pos!.views = i + 1;
    ctx.progress(i + 1, locs.length, `${loc.type} ${loc.id}`);
    await ctx.checkpoint();
  }
}
