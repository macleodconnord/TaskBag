import { isFilterGroup, PRIORITIES, type FilterCondition, type FilterGroup, type FilterOp } from '@app/shared';
import { Check, ChevronDown, Filter, Layers, Plus, Trash2 } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import type { CustomField } from '@/features/fields/public';
import type { Tag, User } from '@/lib/types';
import { StatusDot, TagChip } from '@/components/pickers';
import { Avatar, Button, cx, IconButton, Input, MenuItem, Popover, Select } from '@/components/ui';

// ───────────── field catalogue ─────────────

type Kind = 'text' | 'status' | 'status_group' | 'user' | 'priority' | 'tag' | 'date' | 'bool' | 'number' | 'option' | 'set_only';
interface Opt { value: string; label: string; color?: string; icon?: ReactNode }
interface FieldDef { key: string; label: string; kind: Kind; options?: Opt[]; custom?: boolean }

export interface StatusOption { name: string; color: string; group: 'open' | 'active' | 'done' | 'closed'; ids: string[] }

export interface FilterSources {
  statuses: StatusOption[];
  users: User[];
  tags: Tag[];
  fields: CustomField[];
}

const OP_LABELS: Record<FilterOp, string> = {
  is: 'is', is_not: 'is not', any_of: 'is any of', none_of: 'is none of', contains: 'contains', not_contains: 'does not contain',
  gt: 'is after', gte: 'is on or after', lt: 'is before', lte: 'is on or before', between: 'is between', is_set: 'is set', is_not_set: 'is not set',
};
const NUM_OP_LABELS: Partial<Record<FilterOp, string>> = { gt: '>', gte: '≥', lt: '<', lte: '≤' };

const OPS: Record<Kind, FilterOp[]> = {
  text: ['contains', 'not_contains', 'is', 'is_set', 'is_not_set'],
  status: ['any_of', 'none_of'],
  status_group: ['any_of', 'none_of'],
  user: ['any_of', 'none_of', 'is_set', 'is_not_set'],
  priority: ['any_of', 'none_of', 'is_set', 'is_not_set'],
  tag: ['any_of', 'none_of', 'is_set', 'is_not_set'],
  date: ['is', 'is_not', 'lt', 'gt', 'between', 'is_set', 'is_not_set'],
  bool: ['is'],
  number: ['gt', 'gte', 'lt', 'lte', 'is_set', 'is_not_set'],
  option: ['any_of', 'none_of', 'is_set', 'is_not_set'],
  set_only: ['is_set', 'is_not_set'],
};

export const DATE_TOKENS: Opt[] = [
  { value: 'today', label: 'Today' }, { value: 'yesterday', label: 'Yesterday' }, { value: 'tomorrow', label: 'Tomorrow' },
  { value: 'this_week', label: 'This week' }, { value: 'next_week', label: 'Next week' },
  { value: 'last_7_days', label: 'Last 7 days' }, { value: 'next_7_days', label: 'Next 7 days' },
];

const STATUS_GROUP_OPTS: Opt[] = [
  { value: 'open', label: 'Not started' }, { value: 'active', label: 'Active' }, { value: 'done', label: 'Done' }, { value: 'closed', label: 'Closed' },
];

function customKind(f: CustomField): Kind {
  switch (f.type) {
    case 'text': case 'url': case 'email': case 'phone': return 'text';
    case 'number': case 'currency': case 'rating': case 'progress': return 'number';
    case 'dropdown': case 'labels': return 'option';
    case 'date': return 'date';
    case 'checkbox': return 'bool';
    case 'user': return 'user';
    default: return 'set_only';
  }
}

export function fieldOptions(f: CustomField): Opt[] {
  const opts = (f.config?.options as Array<{ id: string; name?: string; label?: string; color?: string }> | undefined) ?? [];
  return opts.map((o) => ({ value: o.id, label: o.name ?? o.label ?? o.id, color: o.color }));
}

export function filterFields(src: FilterSources): FieldDef[] {
  const builtin: FieldDef[] = [
    { key: 'name', label: 'Task name', kind: 'text' },
    { key: 'status', label: 'Status', kind: 'status' },
    { key: 'status_group', label: 'Status group', kind: 'status_group', options: STATUS_GROUP_OPTS },
    { key: 'assignee', label: 'Assignee', kind: 'user' },
    { key: 'priority', label: 'Priority', kind: 'priority', options: PRIORITIES.map((p) => ({ value: String(p.value), label: p.label, color: p.color })) },
    { key: 'tag', label: 'Tag', kind: 'tag' },
    { key: 'due_at', label: 'Due date', kind: 'date' },
    { key: 'start_at', label: 'Start date', kind: 'date' },
    { key: 'created_at', label: 'Date created', kind: 'date' },
    { key: 'is_subtask', label: 'Is subtask', kind: 'bool' },
  ];
  const custom = src.fields.filter((f) => f.type !== 'formula').map<FieldDef>((f) => ({
    key: `cf:${f.id}`, label: f.name, kind: customKind(f), options: fieldOptions(f), custom: true,
  }));
  return [...builtin, ...custom];
}

const defaultValue = (kind: Kind, op: FilterOp): unknown => {
  if (op === 'is_set' || op === 'is_not_set') return undefined;
  if (kind === 'bool') return true;
  if (kind === 'date') return op === 'between' ? ['today', 'next_7_days'] : 'today';
  if (['status', 'status_group', 'user', 'priority', 'tag', 'option'].includes(kind)) return [];
  return '';
};

/** Number of leaf conditions (for the toolbar badge). */
export const countConditions = (g: FilterGroup | undefined): number =>
  g ? g.conditions.reduce((n, c) => n + (isFilterGroup(c) ? countConditions(c) : 1), 0) : 0;

/** Drop conditions with empty values so half-built rows don't hit the server. */
export function cleanFilter(g: FilterGroup | undefined): FilterGroup | undefined {
  if (!g) return undefined;
  const conditions = g.conditions
    .map((c) => (isFilterGroup(c) ? cleanFilter(c) : c))
    .filter((c): c is FilterCondition | FilterGroup => {
      if (!c) return false;
      if (isFilterGroup(c)) return c.conditions.length > 0;
      if (c.op === 'is_set' || c.op === 'is_not_set') return true;
      if (Array.isArray(c.value)) return c.value.length > 0 && c.value.every((v) => v !== '' && v != null);
      return c.value !== undefined && c.value !== '' && c.value !== null;
    });
  return conditions.length ? { op: g.op, conditions } : undefined;
}

// ───────────── UI ─────────────

/** Toolbar button + popover holding the filter builder. */
export function FilterButton({ value, onChange, sources }: { value: FilterGroup | undefined; onChange: (g: FilterGroup | undefined) => void; sources: FilterSources }) {
  const n = countConditions(cleanFilter(value));
  return (
    <Popover width={700} align="end" trigger={(p) => (
      <Button {...p} size="sm" variant={n ? 'primary' : 'secondary'}><Filter className="size-3.5" />Filter{n ? ` · ${n}` : ''}</Button>
    )}>
      <div className="max-h-[70vh] overflow-y-auto p-2">
        <FilterBuilder value={value ?? { op: 'and', conditions: [] }} onChange={(g) => onChange(g.conditions.length ? g : undefined)} sources={sources} />
      </div>
    </Popover>
  );
}

export function FilterBuilder({ value, onChange, sources }: { value: FilterGroup; onChange: (g: FilterGroup) => void; sources: FilterSources }) {
  const defs = filterFields(sources);
  return (
    <div>
      <GroupEditor group={value} onChange={onChange} defs={defs} sources={sources} depth={0} />
      {value.conditions.length > 0 && (
        <div className="mt-2 flex justify-end border-t border-app pt-2">
          <Button size="sm" variant="ghost" onClick={() => onChange({ op: 'and', conditions: [] })}>Clear all</Button>
        </div>
      )}
    </div>
  );
}

function GroupEditor({ group, onChange, onRemove, defs, sources, depth }: {
  group: FilterGroup; onChange: (g: FilterGroup) => void; onRemove?: () => void; defs: FieldDef[]; sources: FilterSources; depth: number;
}) {
  const set = (i: number, c: FilterCondition | FilterGroup) => onChange({ ...group, conditions: group.conditions.map((x, j) => (j === i ? c : x)) });
  const remove = (i: number) => onChange({ ...group, conditions: group.conditions.filter((_, j) => j !== i) });
  const add = () => onChange({ ...group, conditions: [...group.conditions, { field: 'status_group', op: 'any_of', value: [] }] });
  const addGroup = () => onChange({ ...group, conditions: [...group.conditions, { op: group.op === 'and' ? 'or' : 'and', conditions: [{ field: 'assignee', op: 'any_of', value: [] }] }] });

  return (
    <div className={cx(depth > 0 && 'rounded-lg border border-app bg-subtle p-2')}>
      {!group.conditions.length && depth === 0 && <div className="px-1 pb-2 text-sm text-muted">No filters. Add a condition to narrow this view.</div>}
      <div className="flex flex-col gap-1.5">
        {group.conditions.map((c, i) => (
          <div key={i} className="flex items-start gap-1.5">
            <div className="w-[4.5rem] shrink-0 pt-1 text-right text-xs text-muted">
              {i === 0 ? 'Where' : i === 1 ? (
                <Select className="h-7 w-[4.5rem] text-xs" value={group.op} onChange={(e) => onChange({ ...group, op: e.target.value as 'and' | 'or' })} aria-label="Match">
                  <option value="and">and</option>
                  <option value="or">or</option>
                </Select>
              ) : group.op}
            </div>
            <div className="min-w-0 flex-1">
              {isFilterGroup(c) ? (
                <GroupEditor group={c} onChange={(g) => set(i, g)} onRemove={() => remove(i)} defs={defs} sources={sources} depth={depth + 1} />
              ) : (
                <ConditionRow cond={c} onChange={(n) => set(i, n)} onRemove={() => remove(i)} defs={defs} sources={sources} />
              )}
            </div>
          </div>
        ))}
      </div>
      <div className="mt-2 flex items-center gap-1 pl-[4.9rem]">
        <Button size="sm" variant="ghost" onClick={add}><Plus className="size-3.5" />Add filter</Button>
        {depth === 0 && <Button size="sm" variant="ghost" onClick={addGroup}><Layers className="size-3.5" />Add group</Button>}
        {onRemove && <Button size="sm" variant="ghost" className="ml-auto text-red-600 dark:text-red-400" onClick={onRemove}><Trash2 className="size-3.5" />Remove group</Button>}
      </div>
    </div>
  );
}

function ConditionRow({ cond, onChange, onRemove, defs, sources }: {
  cond: FilterCondition; onChange: (c: FilterCondition) => void; onRemove: () => void; defs: FieldDef[]; sources: FilterSources;
}) {
  const def = defs.find((d) => d.key === cond.field) ?? { key: cond.field, label: 'Unknown field', kind: 'set_only' as Kind };
  const ops = OPS[def.kind];
  const changeField = (key: string) => {
    const d = defs.find((x) => x.key === key)!;
    const op = OPS[d.kind][0];
    onChange({ field: key, op, value: defaultValue(d.kind, op) });
  };
  const changeOp = (op: FilterOp) => {
    const keep = (op === 'between') === (cond.op === 'between') && cond.op !== 'is_set' && cond.op !== 'is_not_set';
    onChange({ ...cond, op, value: keep && cond.value !== undefined ? cond.value : defaultValue(def.kind, op) });
  };
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <Select className="h-7 w-40 text-xs" value={def.key} onChange={(e) => changeField(e.target.value)} aria-label="Field">
        <optgroup label="Task">
          {defs.filter((d) => !d.custom).map((d) => <option key={d.key} value={d.key}>{d.label}</option>)}
        </optgroup>
        {defs.some((d) => d.custom) && (
          <optgroup label="Custom fields">
            {defs.filter((d) => d.custom).map((d) => <option key={d.key} value={d.key}>{d.label}</option>)}
          </optgroup>
        )}
        {!defs.some((d) => d.key === cond.field) && <option value={cond.field}>Unknown field</option>}
      </Select>
      {ops.length > 1 && (
        <Select className="h-7 w-36 text-xs" value={cond.op} onChange={(e) => changeOp(e.target.value as FilterOp)} aria-label="Operator">
          {ops.map((o) => <option key={o} value={o}>{def.kind === 'number' ? NUM_OP_LABELS[o] ?? OP_LABELS[o] : OP_LABELS[o]}</option>)}
        </Select>
      )}
      <div className="min-w-0 flex-1">
        <ValueEditor def={def} cond={cond} onChange={(value) => onChange({ ...cond, value })} sources={sources} />
      </div>
      <IconButton size="sm" label="Remove filter" onClick={onRemove}><Trash2 className="size-3.5" /></IconButton>
    </div>
  );
}

function ValueEditor({ def, cond, onChange, sources }: { def: FieldDef; cond: FilterCondition; onChange: (v: unknown) => void; sources: FilterSources }) {
  if (cond.op === 'is_set' || cond.op === 'is_not_set') return null;
  const arr = Array.isArray(cond.value) ? (cond.value as unknown[]).map(String) : cond.value == null || cond.value === '' ? [] : [String(cond.value)];
  switch (def.kind) {
    case 'text':
      return <DebouncedInput value={String(cond.value ?? '')} onChange={onChange} placeholder="Text…" />;
    case 'number':
      return <DebouncedInput type="number" value={String(cond.value ?? '')} onChange={(v) => onChange(v === '' ? '' : Number(v))} placeholder="Number" />;
    case 'bool':
      return (
        <Select className="h-7 w-24 text-xs" value={String(cond.value !== false && cond.value !== 'false')} onChange={(e) => onChange(e.target.value === 'true')} aria-label="Value">
          <option value="true">Yes</option>
          <option value="false">No</option>
        </Select>
      );
    case 'date':
      if (cond.op === 'between') {
        const [a, b] = Array.isArray(cond.value) ? (cond.value as string[]) : ['today', 'today'];
        return (
          <div className="flex flex-wrap items-center gap-1">
            <DateValue value={a} onChange={(v) => onChange([v, b])} />
            <span className="text-xs text-muted">and</span>
            <DateValue value={b} onChange={(v) => onChange([a, v])} />
          </div>
        );
      }
      return <DateValue value={String(cond.value ?? 'today')} onChange={onChange} />;
    case 'status': {
      const opts: Opt[] = sources.statuses.map((s) => ({ value: s.name, label: s.name, icon: <StatusDot status={s} /> }));
      const selectedNames = sources.statuses.filter((s) => s.ids.some((id) => arr.includes(id))).map((s) => s.name);
      const unknown = arr.filter((id) => !sources.statuses.some((s) => s.ids.includes(id)));
      return (
        <MultiSelect options={opts} value={selectedNames} placeholder="Select statuses" extraLabel={unknown.length ? `+${unknown.length} other` : undefined}
          onChange={(names) => onChange([...unknown, ...sources.statuses.filter((s) => names.includes(s.name)).flatMap((s) => s.ids)])} />
      );
    }
    case 'user': {
      const opts: Opt[] = [
        { value: 'me', label: 'Me (current user)' },
        ...sources.users.filter((u) => u.isActive && !u.isSystem).map((u) => ({ value: u.id, label: u.displayName, icon: <Avatar user={u} size={16} /> })),
      ];
      return <MultiSelect options={opts} value={arr} onChange={onChange} placeholder="Select people" />;
    }
    case 'tag': {
      const byName = new Map<string, Tag>();
      for (const t of sources.tags) if (!byName.has(t.id)) byName.set(t.id, t);
      const opts: Opt[] = [...byName.values()].map((t) => ({ value: t.id, label: t.name, icon: <TagChip tag={t} /> }));
      return <MultiSelect options={opts} value={arr} onChange={onChange} placeholder="Select tags" iconOnly />;
    }
    case 'priority': case 'status_group': case 'option':
      return <MultiSelect options={def.options ?? []} value={arr} onChange={onChange} placeholder="Select…" />;
    default:
      return null;
  }
}

function DebouncedInput({ value, onChange, type = 'text', placeholder }: { value: string; onChange: (v: string) => void; type?: string; placeholder?: string }) {
  const [v, setV] = useState(value);
  useEffect(() => setV(value), [value]);
  useEffect(() => {
    if (v === value) return;
    const t = setTimeout(() => onChange(v), 400);
    return () => clearTimeout(t);
  }, [v]); // eslint-disable-line react-hooks/exhaustive-deps
  return <Input type={type} className="h-7 text-xs" value={v} placeholder={placeholder} onChange={(e) => setV(e.target.value)} onBlur={() => v !== value && onChange(v)} />;
}

/** A relative token (today, this_week, …) or an exact yyyy-mm-dd date. */
function DateValue({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const isToken = DATE_TOKENS.some((t) => t.value === value);
  return (
    <div className="flex items-center gap-1">
      <Select className="h-7 w-32 text-xs" value={isToken ? value : 'exact'} aria-label="Date"
        onChange={(e) => onChange(e.target.value === 'exact' ? new Date().toISOString().slice(0, 10) : e.target.value)}>
        {DATE_TOKENS.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
        <option value="exact">Exact date…</option>
      </Select>
      {!isToken && <Input type="date" className="h-7 w-36 text-xs" value={value.slice(0, 10)} onChange={(e) => e.target.value && onChange(e.target.value)} />}
    </div>
  );
}

function MultiSelect({ options, value, onChange, placeholder, extraLabel, iconOnly }: {
  options: Opt[]; value: string[]; onChange: (v: string[]) => void; placeholder: string; extraLabel?: string; iconOnly?: boolean;
}) {
  const [q, setQ] = useState('');
  const selected = options.filter((o) => value.includes(o.value));
  const shown = options.filter((o) => !q || o.label.toLowerCase().includes(q.toLowerCase()));
  const toggle = (v: string) => onChange(value.includes(v) ? value.filter((x) => x !== v) : [...value, v]);
  return (
    <Popover width={240} trigger={(p) => (
      <button {...p} type="button" className="flex h-7 w-full min-w-28 items-center gap-1 overflow-hidden rounded-md border border-app bg-app px-2 text-left text-xs hover-bg">
        <span className="min-w-0 flex-1 truncate">
          {selected.length ? selected.map((o) => o.label).join(', ') : <span className="text-subtle">{placeholder}</span>}
          {extraLabel && <span className="ml-1 text-subtle">{extraLabel}</span>}
        </span>
        <ChevronDown className="size-3.5 shrink-0 text-subtle" />
      </button>
    )}>
      {options.length > 7 && <Input autoFocus className="mb-1 h-7 text-xs" placeholder="Search…" value={q} onChange={(e) => setQ(e.target.value)} />}
      <div className="max-h-64 overflow-y-auto">
        {shown.map((o) => (
          <MenuItem key={o.value} icon={iconOnly ? undefined : o.icon ?? (o.color ? <span className="size-2.5 rounded-full" style={{ backgroundColor: o.color }} /> : undefined)}
            onClick={() => toggle(o.value)} right={value.includes(o.value) ? <Check className="size-4 text-accent-600" /> : null}>
            {iconOnly && o.icon ? o.icon : o.label}
          </MenuItem>
        ))}
        {!shown.length && <div className="px-2 py-3 text-center text-xs text-muted">Nothing to choose</div>}
      </div>
    </Popover>
  );
}
