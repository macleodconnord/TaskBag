import { isFilterGroup, type FilterCondition, type FilterGroup } from '@app/shared';
import { and, asc, desc, sql, type SQL } from 'drizzle-orm';
import { tasks } from '../../db/schema';
import { resolveDateRange } from '../../lib/dates';
import { Validation } from '../../lib/errors';

/**
 * Compiles the shared FilterAST to SQL over `tasks`. It is always ANDed with the ACL filter
 * by the caller (permissions.md §4), so it can never widen visibility.
 *
 * Custom field values (task_field_values.value jsonb) by type:
 *   text/url/email/phone: string · number/currency/rating/progress: number · dropdown: optionId
 *   labels: optionId[] · date: ISO string · checkbox: boolean · user: userId[] · relationship: taskId[]
 */
export interface FilterContext {
  userId: string;
  tz: string;
}

const DATE_COLS = {
  due_at: tasks.dueAt, start_at: tasks.startAt, created_at: tasks.createdAt,
  updated_at: tasks.updatedAt, completed_at: tasks.completedAt,
} as const;

const arr = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : v == null || v === '' ? [] : [String(v)]);
/** Dates as explicit timestamptz params (the pg driver doesn't serialize Date objects inside raw sql``). */
const ts = (d: Date) => sql`${d.toISOString()}::timestamptz`;
const uuidList = (ids: string[]) => sql.join(ids.map((i) => sql`${i}::uuid`), sql`, `);

export function compileFilter(group: FilterGroup | undefined, ctx: FilterContext): SQL | undefined {
  if (!group || !group.conditions.length) return undefined;
  const parts = group.conditions
    .map((c) => (isFilterGroup(c) ? compileFilter(c, ctx) : compileCondition(c, ctx)))
    .filter((p): p is SQL => !!p);
  if (!parts.length) return undefined;
  return sql`(${sql.join(parts, group.op === 'and' ? sql` and ` : sql` or `)})`;
}

function inSet(col: SQL, ids: string[], negate: boolean): SQL {
  if (!ids.length) return negate ? sql`true` : sql`false`;
  return negate ? sql`${col} not in (${uuidList(ids)})` : sql`${col} in (${uuidList(ids)})`;
}

function compileCondition(c: FilterCondition, ctx: FilterContext): SQL | undefined {
  const me = (ids: string[]) => ids.map((i) => (i === 'me' ? ctx.userId : i));
  const neg = c.op === 'is_not' || c.op === 'none_of';
  switch (c.field) {
    case 'name': {
      const v = String(c.value ?? '');
      if (c.op === 'contains') return sql`${tasks.name} ilike ${'%' + v + '%'}`;
      if (c.op === 'not_contains') return sql`${tasks.name} not ilike ${'%' + v + '%'}`;
      if (c.op === 'is') return sql`lower(${tasks.name}) = lower(${v})`;
      break;
    }
    case 'status':
      return inSet(sql`${tasks.statusId}`, arr(c.value), neg);
    case 'status_group': {
      const groups = arr(c.value);
      if (!groups.length) return undefined;
      const q = sql`(select s."group"::text from statuses s where s.id = ${tasks.statusId}) in (${sql.join(groups.map((g) => sql`${g}`), sql`, `)})`;
      return neg ? sql`not ${q}` : q;
    }
    case 'assignee': {
      if (c.op === 'is_set') return sql`exists (select 1 from task_assignees a where a.task_id = ${tasks.id})`;
      if (c.op === 'is_not_set') return sql`not exists (select 1 from task_assignees a where a.task_id = ${tasks.id})`;
      const ids = me(arr(c.value));
      if (!ids.length) return undefined;
      const q = sql`exists (select 1 from task_assignees a where a.task_id = ${tasks.id} and a.user_id in (${uuidList(ids)}))`;
      return neg ? sql`not ${q}` : q;
    }
    case 'created_by':
      return inSet(sql`${tasks.createdBy}`, me(arr(c.value)), neg);
    case 'list':
      return inSet(sql`${tasks.listId}`, arr(c.value), neg);
    case 'priority': {
      if (c.op === 'is_set') return sql`${tasks.priority} is not null`;
      if (c.op === 'is_not_set') return sql`${tasks.priority} is null`;
      const vals = arr(c.value).map(Number).filter((n) => n >= 1 && n <= 4);
      if (!vals.length) return undefined;
      const q = sql`${tasks.priority} in (${sql.join(vals.map((v) => sql`${v}`), sql`, `)})`;
      return neg ? sql`(${tasks.priority} is null or not ${q})` : q;
    }
    case 'tag': {
      if (c.op === 'is_set') return sql`exists (select 1 from task_tags tt where tt.task_id = ${tasks.id})`;
      if (c.op === 'is_not_set') return sql`not exists (select 1 from task_tags tt where tt.task_id = ${tasks.id})`;
      const ids = arr(c.value);
      if (!ids.length) return undefined;
      const q = sql`exists (select 1 from task_tags tt where tt.task_id = ${tasks.id} and tt.tag_id in (${uuidList(ids)}))`;
      return neg ? sql`not ${q}` : q;
    }
    case 'is_subtask':
      return c.value === false || c.value === 'false' ? sql`${tasks.parentTaskId} is null` : sql`${tasks.parentTaskId} is not null`;
  }
  if (c.field in DATE_COLS) return dateCondition(sql`${DATE_COLS[c.field as keyof typeof DATE_COLS]}`, c, ctx);
  if (c.field.startsWith('cf:')) return customFieldCondition(c.field.slice(3), c, ctx);
  throw new Validation(`Unknown filter field: ${c.field}`);
}

function dateCondition(col: SQL, c: FilterCondition, ctx: FilterContext): SQL | undefined {
  if (c.op === 'is_set') return sql`${col} is not null`;
  if (c.op === 'is_not_set') return sql`${col} is null`;
  if (c.op === 'between') {
    const [a, b] = Array.isArray(c.value) ? c.value : [];
    const ra = resolveDateRange(a, ctx.tz);
    const rb = resolveDateRange(b, ctx.tz);
    if (!ra || !rb) return undefined;
    return sql`(${col} >= ${ts(ra[0])} and ${col} < ${ts(rb[1])})`;
  }
  const r = resolveDateRange(c.value, ctx.tz);
  if (!r) return undefined;
  const [start, end] = r;
  switch (c.op) {
    case 'is': return start.getTime() === end.getTime() ? sql`${col} = ${ts(start)}` : sql`(${col} >= ${ts(start)} and ${col} < ${ts(end)})`;
    case 'is_not': return sql`(${col} is null or ${col} < ${ts(start)} or ${col} >= ${ts(end)})`;
    case 'lt': return sql`${col} < ${ts(start)}`;
    case 'lte': return sql`${col} < ${ts(end.getTime() === start.getTime() ? start : end)}`;
    case 'gt': return sql`${col} >= ${ts(end.getTime() === start.getTime() ? start : end)}`;
    case 'gte': return sql`${col} >= ${ts(start)}`;
  }
  return undefined;
}

function customFieldCondition(fieldId: string, c: FilterCondition, ctx: FilterContext): SQL | undefined {
  if (!/^[0-9a-f-]{36}$/i.test(fieldId)) throw new Validation('Bad custom field id');
  const v = sql`(select fv.value from task_field_values fv where fv.task_id = ${tasks.id} and fv.field_id = ${fieldId}::uuid)`;
  const txt = sql`(${v} #>> '{}')`;
  const val = c.value;
  switch (c.op) {
    case 'is_set': return sql`(${v} is not null and ${v} <> 'null'::jsonb and ${v} <> '[]'::jsonb and ${v} <> '""'::jsonb)`;
    case 'is_not_set': return sql`(${v} is null or ${v} = 'null'::jsonb or ${v} = '[]'::jsonb or ${v} = '""'::jsonb)`;
    case 'contains': return sql`${txt} ilike ${'%' + String(val ?? '') + '%'}`;
    case 'not_contains': return sql`coalesce(${txt}, '') not ilike ${'%' + String(val ?? '') + '%'}`;
    case 'gt': case 'gte': case 'lt': case 'lte': {
      const op = { gt: sql`>`, gte: sql`>=`, lt: sql`<`, lte: sql`<=` }[c.op];
      if (typeof val === 'number' || (typeof val === 'string' && /^-?\d+(\.\d+)?$/.test(val))) {
        return sql`(case when jsonb_typeof(${v}) = 'number' then (${v})::numeric end) ${op} ${Number(val)}`;
      }
      const r = resolveDateRange(val, ctx.tz);
      if (!r) return undefined;
      return sql`(${txt})::timestamptz ${op} ${ts(c.op.startsWith('g') ? r[1] : r[0])}`;
    }
    case 'is': case 'is_not': {
      if (typeof val === 'boolean') {
        const q = sql`coalesce((${v})::text = ${String(val)}, ${val === false})`;
        return c.op === 'is' ? q : sql`not ${q}`;
      }
      const q = sql`(${v} = to_jsonb(${val as string}::text) or ${v} @> to_jsonb(array[${String(val)}]::text[]))`;
      return c.op === 'is' ? sql`coalesce(${q}, false)` : sql`not coalesce(${q}, false)`;
    }
    case 'any_of': case 'none_of': {
      const ids = arr(val).map((i) => (i === 'me' ? ctx.userId : i));
      if (!ids.length) return undefined;
      const list = sql.join(ids.map((i) => sql`${i}`), sql`, `);
      const q = sql`coalesce((${txt} in (${list}) or exists (select 1 from jsonb_array_elements_text(case when jsonb_typeof(${v}) = 'array' then ${v} else '[]'::jsonb end) e where e in (${list}))), false)`;
      return c.op === 'any_of' ? q : sql`not ${q}`;
    }
  }
  return undefined;
}

export function compileSort(sort: Array<{ field: string; dir: 'asc' | 'desc' }>): SQL[] {
  const out: SQL[] = [];
  for (const s of sort) {
    const dir = s.dir === 'desc' ? desc : asc;
    const nulls = s.dir === 'desc' ? sql`nulls last` : sql`nulls last`;
    switch (s.field) {
      case 'name': out.push(dir(sql`lower(${tasks.name})`)); break;
      case 'key': out.push(dir(tasks.seq)); break;
      case 'priority': out.push(sql`${tasks.priority} ${s.dir === 'desc' ? sql`desc` : sql`asc`} ${nulls}`); break;
      case 'status': out.push(dir(sql`(select position from statuses where id = ${tasks.statusId})`)); break;
      case 'position': out.push(dir(tasks.position)); break;
      case 'due_at': case 'start_at': case 'created_at': case 'updated_at': case 'completed_at': {
        const col = DATE_COLS[s.field];
        out.push(sql`${col} ${s.dir === 'desc' ? sql`desc` : sql`asc`} ${nulls}`);
        break;
      }
      default:
        if (s.field.startsWith('cf:') && /^[0-9a-f-]{36}$/i.test(s.field.slice(3))) {
          const v = sql`(select fv.value from task_field_values fv where fv.task_id = ${tasks.id} and fv.field_id = ${s.field.slice(3)}::uuid)`;
          out.push(sql`(case when jsonb_typeof(${v}) = 'number' then (${v})::numeric end) ${s.dir === 'desc' ? sql`desc` : sql`asc`} nulls last`);
          out.push(sql`(${v} #>> '{}') ${s.dir === 'desc' ? sql`desc` : sql`asc`} nulls last`);
        }
    }
  }
  return out;
}

export const andAll = (...parts: Array<SQL | undefined>) => and(...parts.filter((p): p is SQL => !!p));
