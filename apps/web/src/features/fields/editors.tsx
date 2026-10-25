import type { FieldType } from '@app/shared';
import { useMutation, useQuery, useQueryClient, type QueryKey } from '@tanstack/react-query';
import { Check, ExternalLink, Mail, Phone, Search, Star, X } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { UserSearchList } from '@/components/pickers';
import { useOpenTask } from '@/components/task/TaskDrawer';
import { toast } from '@/components/toast';
import { Avatar, AvatarStack, cx, Input, MenuItem, MenuSeparator, Popover } from '@/components/ui';
import { api, qs } from '@/lib/api';
import { formatDate, fromDateInput, toDateInput } from '@/lib/format';
import { useUsers } from '@/lib/queries';
import type { Task, TaskDetail } from '@/lib/types';

/** Minimal field shape the editors need (matches public `CustomField`). */
export interface FieldLike {
  id: string;
  name: string;
  type: FieldType;
  config: Record<string, unknown>;
}
export interface FieldOption { id: string; name: string; color: string }

export const fieldOptions = (f: FieldLike) => ((f.config.options as FieldOption[] | undefined) ?? []);
export const isEmptyValue = (v: unknown) => v === null || v === undefined || v === '' || (Array.isArray(v) && v.length === 0);

/** Plain-text rendering of a value (sorting labels, tooltips, CSV-ish display). */
export function formatFieldValue(f: FieldLike, v: unknown): string {
  if (isEmptyValue(v)) return '';
  switch (f.type) {
    case 'currency': return formatMoney(f, Number(v));
    case 'number': return formatNumber(Number(v), f.config.precision as number | undefined);
    case 'formula': return typeof v === 'number' ? formatNumber(v, f.config.precision as number | undefined) : typeof v === 'boolean' ? (v ? 'Yes' : 'No') : /^\d{4}-\d{2}-\d{2}T/.test(String(v)) ? formatDate(String(v)) : String(v);
    case 'progress': return `${v}%`;
    case 'rating': return `${v}/${Number(f.config.max ?? 5)}`;
    case 'checkbox': return v ? 'Yes' : 'No';
    case 'date': return formatDate(String(v), !!f.config.includeTime);
    case 'dropdown': return fieldOptions(f).find((o) => o.id === v)?.name ?? '';
    case 'labels': return (v as string[]).map((id) => fieldOptions(f).find((o) => o.id === id)?.name).filter(Boolean).join(', ');
    case 'user': case 'relationship': return `${(v as string[]).length}`;
    default: return String(v);
  }
}

export function formatNumber(n: number, precision?: number) {
  if (!Number.isFinite(n)) return '';
  return new Intl.NumberFormat(undefined, precision !== undefined ? { minimumFractionDigits: precision, maximumFractionDigits: precision } : { maximumFractionDigits: 6 }).format(n);
}
export function formatMoney(f: FieldLike, n: number) {
  const currency = String(f.config.currency ?? 'USD');
  const precision = Number(f.config.precision ?? 2);
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency, minimumFractionDigits: precision, maximumFractionDigits: precision }).format(n);
  } catch {
    return `${currency} ${formatNumber(n, precision)}`;
  }
}

// ───────────── writes ─────────────

/** PUT a value with an optimistic update of every cached copy of the task. */
export function useSetFieldValue() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ taskId, fieldId, value }: { taskId: string; fieldId: string; value: unknown }) =>
      api.put<{ value: unknown }>(`/fields/values/${taskId}/${fieldId}`, { value: isEmptyValue(value) ? null : value }),
    onMutate: async ({ taskId, fieldId, value }) => {
      await qc.cancelQueries({ predicate: (q) => q.queryKey[0] === 'tasks' || q.queryKey[0] === 'task' });
      const snaps: Array<[QueryKey, unknown]> = [];
      const patch = (t: Task): Task => {
        const fields = { ...((t.fields as Record<string, unknown> | undefined) ?? {}) };
        if (isEmptyValue(value)) delete fields[fieldId];
        else fields[fieldId] = value;
        return { ...t, fields };
      };
      for (const [key, data] of qc.getQueriesData<Task[] | TaskDetail>({ predicate: (q) => q.queryKey[0] === 'tasks' || q.queryKey[0] === 'task' })) {
        snaps.push([key, data]);
        if (Array.isArray(data)) qc.setQueryData(key, data.map((t) => (t.id === taskId ? patch(t) : t)));
        else if (data && data.id === taskId) qc.setQueryData(key, patch(data));
      }
      return { rollback: () => snaps.forEach(([k, d]) => qc.setQueryData(k, d)) };
    },
    onError: (err, _v, ctx) => {
      ctx?.rollback();
      toast.error(err instanceof Error ? err.message : 'Could not save the field');
    },
    onSettled: () => {
      // formulas and filters depend on values: refetch
      void qc.invalidateQueries({ predicate: (q) => q.queryKey[0] === 'tasks' || q.queryKey[0] === 'task' });
    },
  });
}

// ───────────── value editor ─────────────

export type Variant = 'cell' | 'detail';

const trig = (variant: Variant, extra?: string) => cx(
  'flex min-w-0 items-center rounded text-left text-sm',
  variant === 'cell' ? 'h-7 w-full px-1' : 'min-h-7 w-full px-1.5',
  extra,
);
const Placeholder = ({ variant }: { variant: Variant }) => <span className="text-subtle">{variant === 'detail' ? 'Empty' : ''}</span>;

/**
 * Display + inline editor for one field value. `onChange` receives the new value (null clears).
 * Read-only when `editable` is false (and always for formulas).
 */
export function FieldValueEditor({ field, value, editable, onChange, variant = 'cell' }: {
  field: FieldLike;
  value: unknown;
  editable: boolean;
  onChange: (v: unknown) => void;
  variant?: Variant;
}) {
  const ro = !editable || field.type === 'formula';
  switch (field.type) {
    case 'text': case 'number': case 'currency': case 'url': case 'email': case 'phone':
      return <TextLikeEditor field={field} value={value} readOnly={ro} onChange={onChange} variant={variant} />;
    case 'checkbox':
      return (
        <div className={trig(variant)}>
          <input type="checkbox" aria-label={field.name} className="size-4 rounded accent-accent-600 disabled:opacity-60" checked={value === true} disabled={ro} onChange={(e) => onChange(e.target.checked ? true : null)} />
        </div>
      );
    case 'rating': return <RatingEditor field={field} value={value as number | null} readOnly={ro} onChange={onChange} variant={variant} />;
    case 'progress': return <ProgressEditor value={value as number | null} readOnly={ro} onChange={onChange} variant={variant} />;
    case 'date': return <DateEditor field={field} value={value as string | null} readOnly={ro} onChange={onChange} variant={variant} />;
    case 'dropdown': case 'labels': return <OptionEditor field={field} value={value} readOnly={ro} onChange={onChange} variant={variant} />;
    case 'user': return <UserEditor field={field} value={(value as string[] | null) ?? []} readOnly={ro} onChange={onChange} variant={variant} />;
    case 'relationship': return <RelationshipEditor field={field} value={(value as string[] | null) ?? []} readOnly={ro} onChange={onChange} variant={variant} />;
    case 'formula':
      return (
        <div className={trig(variant, 'cursor-default')} title={`Formula: ${String(field.config.expression ?? '')}`}>
          {isEmptyValue(value) ? <Placeholder variant={variant} /> : <span className={cx('truncate', typeof value === 'number' && 'tabular-nums')}>{formatFieldValue(field, value)}</span>}
        </div>
      );
  }
  return null;
}

function TextLikeEditor({ field, value, readOnly, onChange, variant }: { field: FieldLike; value: unknown; readOnly: boolean; onChange: (v: unknown) => void; variant: Variant }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const numeric = field.type === 'number' || field.type === 'currency';
  const start = () => { setDraft(value == null ? '' : String(value)); setEditing(true); };
  const commit = () => {
    setEditing(false);
    const t = draft.trim();
    if (t === (value == null ? '' : String(value))) return;
    if (numeric) {
      if (t === '') return onChange(null);
      const n = Number(t.replace(/[,\s]/g, ''));
      if (!Number.isFinite(n)) return toast.error(`${field.name}: enter a number`);
      return onChange(n);
    }
    onChange(t || null);
  };
  if (editing) {
    return (
      <Input
        autoFocus
        className={cx(variant === 'cell' ? 'h-7' : 'h-8', numeric && 'tabular-nums', numeric && variant === 'cell' && 'text-right')}
        type={numeric ? 'text' : field.type === 'email' ? 'email' : field.type === 'url' ? 'url' : 'text'}
        inputMode={numeric ? 'decimal' : undefined}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commit();
          if (e.key === 'Escape') setEditing(false);
          e.stopPropagation();
        }}
      />
    );
  }
  const empty = isEmptyValue(value);
  let content: ReactNode = empty ? <Placeholder variant={variant} /> : <span className={cx('truncate', numeric && 'tabular-nums', numeric && variant === 'cell' && 'ml-auto')}>{formatFieldValue(field, value)}</span>;
  if (!empty && field.type === 'url') {
    content = (
      <a href={String(value)} target="_blank" rel="noreferrer noopener" onClick={(e) => e.stopPropagation()} className="inline-flex min-w-0 items-center gap-1 text-accent-600 hover:underline dark:text-accent-500">
        <span className="truncate">{String(value).replace(/^https?:\/\//, '')}</span><ExternalLink className="size-3 shrink-0" />
      </a>
    );
  } else if (!empty && (field.type === 'email' || field.type === 'phone')) {
    const Icon = field.type === 'email' ? Mail : Phone;
    content = (
      <a href={`${field.type === 'email' ? 'mailto' : 'tel'}:${String(value)}`} onClick={(e) => e.stopPropagation()} className="inline-flex min-w-0 items-center gap-1 hover:underline">
        <Icon className="size-3 shrink-0 text-subtle" /><span className="truncate">{String(value)}</span>
      </a>
    );
  }
  if (readOnly) return <div className={trig(variant)}>{content}</div>;
  return (
    <div role="button" tabIndex={0} className={trig(variant, 'cursor-text hover-bg')} onClick={start} onKeyDown={(e) => e.key === 'Enter' && start()} title={`Edit ${field.name}`}>
      {content}
    </div>
  );
}

function RatingEditor({ field, value, readOnly, onChange, variant }: { field: FieldLike; value: number | null; readOnly: boolean; onChange: (v: unknown) => void; variant: Variant }) {
  const max = Number(field.config.max ?? 5);
  const [hover, setHover] = useState<number | null>(null);
  const shown = hover ?? value ?? 0;
  return (
    <div className={trig(variant, 'gap-0.5')} onMouseLeave={() => setHover(null)}>
      {Array.from({ length: max }, (_, i) => i + 1).map((n) => (
        <button
          key={n}
          type="button"
          disabled={readOnly}
          aria-label={`${n} of ${max}`}
          onMouseEnter={() => !readOnly && setHover(n)}
          onClick={(e) => { e.stopPropagation(); onChange(value === n ? null : n); }}
          className="disabled:cursor-default"
        >
          <Star className={cx('size-4', n <= shown ? 'fill-amber-400 text-amber-400' : 'text-[var(--border)]')} />
        </button>
      ))}
    </div>
  );
}

function ProgressEditor({ value, readOnly, onChange, variant }: { value: number | null; readOnly: boolean; onChange: (v: unknown) => void; variant: Variant }) {
  const [draft, setDraft] = useState(value ?? 0);
  useEffect(() => setDraft(value ?? 0), [value]);
  const bar = (
    <span className="flex w-full items-center gap-2">
      <span className="h-1.5 min-w-10 flex-1 overflow-hidden rounded-full bg-muted">
        <span className="block h-full rounded-full bg-emerald-500" style={{ width: `${Math.max(0, Math.min(100, value ?? 0))}%` }} />
      </span>
      <span className="w-9 shrink-0 text-right text-xs tabular-nums text-muted">{value ?? 0}%</span>
    </span>
  );
  if (readOnly) return <div className={trig(variant)}>{bar}</div>;
  return (
    <Popover width={220} trigger={(p) => <button {...p} type="button" className={trig(variant, 'hover-bg')}>{bar}</button>}>
      {(close) => (
        <div className="space-y-2 p-2">
          <input type="range" min={0} max={100} step={5} value={draft} onChange={(e) => setDraft(Number(e.target.value))} className="w-full accent-accent-600" aria-label="Progress" />
          <div className="flex items-center gap-2">
            <Input type="number" min={0} max={100} value={draft} onChange={(e) => setDraft(Math.max(0, Math.min(100, Number(e.target.value))))} className="w-20" />
            <span className="text-sm text-muted">%</span>
            <button type="button" className="ml-auto rounded-md bg-accent-600 px-2 py-1 text-xs font-medium text-white hover:bg-accent-700" onClick={() => { onChange(draft || null); close(); }}>Save</button>
          </div>
        </div>
      )}
    </Popover>
  );
}

function DateEditor({ field, value, readOnly, onChange, variant }: { field: FieldLike; value: string | null; readOnly: boolean; onChange: (v: unknown) => void; variant: Variant }) {
  const display = value ? <span className="truncate">{formatDate(value, !!field.config.includeTime)}</span> : <Placeholder variant={variant} />;
  if (readOnly) return <div className={trig(variant)}>{display}</div>;
  return (
    <Popover width={240} trigger={(p) => <button {...p} type="button" className={trig(variant, 'hover-bg')}>{display}</button>}>
      {(close) => (
        <div className="p-1">
          {field.config.includeTime ? (
            <Input type="datetime-local" defaultValue={value ? new Date(new Date(value).getTime() - new Date(value).getTimezoneOffset() * 60000).toISOString().slice(0, 16) : ''}
              onChange={(e) => { if (e.target.value) onChange(new Date(e.target.value).toISOString()); }} />
          ) : (
            <Input type="date" defaultValue={toDateInput(value)} onChange={(e) => { if (e.target.value) { onChange(fromDateInput(e.target.value)); close(); } }} />
          )}
          <div className="mt-1">
            {[['Today', 0], ['Tomorrow', 1], ['Next week', 7]].map(([l, n]) => (
              <MenuItem key={l} onClick={() => { const d = new Date(); d.setDate(d.getDate() + (n as number)); d.setHours(12, 0, 0, 0); onChange(d.toISOString()); close(); }}>{l}</MenuItem>
            ))}
            {value && <><MenuSeparator /><MenuItem icon={<X className="size-4" />} onClick={() => { onChange(null); close(); }}>Clear</MenuItem></>}
          </div>
        </div>
      )}
    </Popover>
  );
}

export function OptionChip({ option }: { option: FieldOption }) {
  return (
    <span className="inline-flex h-5 max-w-full items-center truncate rounded px-1.5 text-[11px] font-medium" style={{ backgroundColor: `${option.color}26`, color: option.color }}>
      <span className="truncate">{option.name}</span>
    </span>
  );
}

function OptionEditor({ field, value, readOnly, onChange, variant }: { field: FieldLike; value: unknown; readOnly: boolean; onChange: (v: unknown) => void; variant: Variant }) {
  const opts = fieldOptions(field);
  const multi = field.type === 'labels';
  const selected: string[] = multi ? ((value as string[] | null) ?? []) : value ? [String(value)] : [];
  const chips = selected.length
    ? <span className="flex min-w-0 flex-wrap items-center gap-1 overflow-hidden">{selected.map((id) => opts.find((o) => o.id === id)).filter(Boolean).map((o) => <OptionChip key={o!.id} option={o!} />)}</span>
    : <Placeholder variant={variant} />;
  if (readOnly) return <div className={trig(variant)}>{chips}</div>;
  return (
    <Popover width={220} trigger={(p) => <button {...p} type="button" className={trig(variant, 'hover-bg')}>{chips}</button>}>
      {(close) => (
        <div className="max-h-72 overflow-y-auto">
          {!opts.length && <div className="px-2 py-3 text-center text-sm text-muted">No options yet. Add them in “Manage fields”.</div>}
          {opts.map((o) => (
            <MenuItem key={o.id} active={selected.includes(o.id)} right={selected.includes(o.id) ? <Check className="size-4" /> : null}
              onClick={() => {
                if (multi) onChange(selected.includes(o.id) ? selected.filter((x) => x !== o.id) : [...selected, o.id]);
                else { onChange(selected.includes(o.id) ? null : o.id); close(); }
              }}>
              <OptionChip option={o} />
            </MenuItem>
          ))}
          {selected.length > 0 && <><MenuSeparator /><MenuItem icon={<X className="size-4" />} onClick={() => { onChange(null); close(); }}>Clear</MenuItem></>}
        </div>
      )}
    </Popover>
  );
}

function UserEditor({ field, value, readOnly, onChange, variant }: { field: FieldLike; value: string[]; readOnly: boolean; onChange: (v: unknown) => void; variant: Variant }) {
  const { data: users = [] } = useUsers();
  const people = value.map((id) => users.find((u) => u.id === id) ?? { id, displayName: '…', avatarUrl: null });
  const display = people.length
    ? (variant === 'detail' && people.length === 1
      ? <span className="inline-flex items-center gap-1.5"><Avatar user={people[0]} size={20} /><span className="truncate">{people[0].displayName}</span></span>
      : <AvatarStack users={people} size={20} />)
    : <Placeholder variant={variant} />;
  if (readOnly) return <div className={trig(variant)}>{display}</div>;
  const multiple = field.config.multiple !== false;
  return (
    <Popover width={260} trigger={(p) => <button {...p} type="button" className={trig(variant, 'hover-bg')}>{display}</button>}>
      {(close) => (
        <UserSearchList selected={value} onToggle={(id) => {
          if (!multiple) { onChange(value.includes(id) ? null : [id]); close(); return; }
          onChange(value.includes(id) ? value.filter((x) => x !== id) : [...value, id]);
        }} />
      )}
    </Popover>
  );
}

type TaskRefLite = { id: string; key: string; name: string; completedAt: string | null };

/** Names for related task ids (only tasks the viewer can see come back). */
export function useTaskRefs(ids: string[]) {
  const key = [...ids].sort().join(',');
  return useQuery({
    queryKey: ['field-task-refs', key],
    queryFn: () => api.get<TaskRefLite[]>(`/tasks${qs({ ids: key, includeClosed: true, includeSubtasks: true })}`),
    enabled: ids.length > 0,
    staleTime: 30_000,
  });
}

function RelationshipEditor({ field, value, readOnly, onChange, variant }: { field: FieldLike; value: string[]; readOnly: boolean; onChange: (v: unknown) => void; variant: Variant }) {
  const { data: refs = [] } = useTaskRefs(value);
  const shown = value.map((id) => refs.find((r) => r.id === id)).filter((r): r is TaskRefLite => !!r);
  const openTask = useOpenTask();
  const chips = shown.length ? (
    <span className="flex min-w-0 flex-wrap items-center gap-1 overflow-hidden">
      {shown.map((t) => (
        <span key={t.id} className="inline-flex h-5 max-w-full items-center gap-1 rounded bg-muted px-1.5 text-[11px]">
          <span role="link" tabIndex={0} className={cx('cursor-pointer truncate hover:underline', t.completedAt && 'line-through opacity-70')} onClick={(e) => { e.stopPropagation(); openTask(t.key); }} onKeyDown={(e) => e.key === 'Enter' && openTask(t.key)}>
            <span className="font-mono text-muted">{t.key}</span> {variant === 'detail' && t.name}
          </span>
          {!readOnly && <span role="button" tabIndex={0} aria-label="Remove" className="text-subtle hover:text-red-600" onClick={(e) => { e.stopPropagation(); onChange(value.filter((x) => x !== t.id)); }}><X className="size-3" /></span>}
        </span>
      ))}
    </span>
  ) : <Placeholder variant={variant} />;
  if (readOnly) return <div className={trig(variant)}>{chips}</div>;
  return (
    <Popover width={320} trigger={(p) => <div {...p} role="button" tabIndex={0} className={trig(variant, 'cursor-pointer hover-bg')}>{chips}</div>}>
      <TaskSearch targetListId={(field.config.targetListId as string | null | undefined) ?? undefined} exclude={value} onPick={(id) => onChange([...value, id])} />
    </Popover>
  );
}

function TaskSearch({ targetListId, exclude, onPick }: { targetListId?: string; exclude: string[]; onPick: (id: string) => void }) {
  const [q, setQ] = useState('');
  const { data = [] } = useQuery({
    queryKey: ['field-task-search', targetListId ?? '', q],
    queryFn: () => api.get<TaskRefLite[]>(`/tasks${qs({ q: q || undefined, listId: targetListId, includeClosed: true, includeSubtasks: true, limit: 20 })}`),
    enabled: q.length > 1 || !!targetListId,
  });
  return (
    <div>
      <div className="relative mb-1">
        <Search className="pointer-events-none absolute left-2 top-2 size-4 text-subtle" />
        <Input autoFocus className="pl-7" placeholder="Search tasks by name or key…" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      <div className="max-h-64 overflow-y-auto">
        {data.filter((t) => !exclude.includes(t.id)).map((t) => (
          <MenuItem key={t.id} onClick={() => onPick(t.id)}><span className="mr-2 font-mono text-xs text-muted">{t.key}</span>{t.name}</MenuItem>
        ))}
        {(q.length > 1 || targetListId) && !data.length && <div className="px-2 py-3 text-center text-sm text-muted">No matching tasks</div>}
      </div>
    </div>
  );
}
