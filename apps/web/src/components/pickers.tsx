import { PRIORITIES } from '@app/shared';
import { useQueryClient } from '@tanstack/react-query';
import { Calendar, Check, Flag, Plus, Search, Tag as TagIcon, UserPlus, X } from 'lucide-react';
import { useMemo, useState, type ReactNode } from 'react';
import { api } from '@/lib/api';
import { dueTone, formatDue, fromDateInput, toDateInput } from '@/lib/format';
import { keys, useTags, useUsers } from '@/lib/queries';
import type { MiniUser, Status, Tag } from '@/lib/types';
import { Avatar, AvatarStack, Button, cx, textOn, Input, MenuItem, MenuLabel, MenuSeparator, Popover } from './ui';

// ───────────── status ─────────────

export function StatusDot({ status, size = 10 }: { status: Pick<Status, 'color' | 'group'> | null | undefined; size?: number }) {
  if (!status) return null;
  const done = status.group === 'done' || status.group === 'closed';
  return (
    <span
      className="inline-flex shrink-0 items-center justify-center rounded-full"
      style={{ width: size, height: size, backgroundColor: done ? status.color : 'transparent', border: `2px solid ${status.color}` }}
    >
      {done && <Check style={{ width: size - 3, height: size - 3, color: textOn(status.color) }} strokeWidth={4} />}
    </span>
  );
}

export function StatusPill({ status }: { status: Status | null | undefined }) {
  if (!status) return null;
  return (
    <span className="inline-flex h-6 items-center gap-1.5 rounded px-2 text-[11px] font-semibold uppercase tracking-wide" style={{ backgroundColor: status.color, color: textOn(status.color) }}>
      {status.name}
    </span>
  );
}

export function StatusPicker({ statuses, value, onChange, disabled, trigger }: {
  statuses: Status[];
  value: string;
  onChange: (id: string) => void;
  disabled?: boolean;
  trigger?: (s: Status | undefined) => ReactNode;
}) {
  const current = statuses.find((s) => s.id === value);
  if (disabled) return <>{trigger ? trigger(current) : <StatusPill status={current} />}</>;
  return (
    <Popover
      width={220}
      trigger={(p) => (
        <button {...p} className="inline-flex items-center rounded focus-visible:outline-2" title="Change status">
          {trigger ? trigger(current) : <StatusPill status={current} />}
        </button>
      )}
    >
      {(close) => (
        <div className="max-h-80 overflow-y-auto">
          {(['open', 'active', 'done', 'closed'] as const).map((g) => {
            const items = statuses.filter((s) => s.group === g);
            if (!items.length) return null;
            return (
              <div key={g}>
                <MenuLabel>{g}</MenuLabel>
                {items.map((s) => (
                  <MenuItem key={s.id} icon={<StatusDot status={s} />} active={s.id === value} onClick={() => { onChange(s.id); close(); }} right={s.id === value ? <Check className="size-4" /> : null}>
                    {s.name}
                  </MenuItem>
                ))}
              </div>
            );
          })}
        </div>
      )}
    </Popover>
  );
}

// ───────────── priority ─────────────

export function PriorityFlag({ value, showLabel }: { value: number | null | undefined; showLabel?: boolean }) {
  const p = PRIORITIES.find((x) => x.value === value);
  if (!p) return showLabel ? <span className="text-subtle">—</span> : <Flag className="size-4 text-subtle" />;
  return (
    <span className="inline-flex items-center gap-1 text-sm" title={`${p.label} priority`}>
      <Flag className="size-4" style={{ color: p.color, fill: p.color }} />
      {showLabel && p.label}
    </span>
  );
}

export function PriorityPicker({ value, onChange, disabled, showLabel }: { value: number | null; onChange: (v: number | null) => void; disabled?: boolean; showLabel?: boolean }) {
  if (disabled) return <PriorityFlag value={value} showLabel={showLabel} />;
  return (
    <Popover
      width={170}
      trigger={(p) => (
        <button {...p} className="inline-flex items-center rounded px-1 hover-bg" title="Priority">
          <PriorityFlag value={value} showLabel={showLabel} />
        </button>
      )}
    >
      {(close) => (
        <>
          {PRIORITIES.map((p) => (
            <MenuItem key={p.value} icon={<Flag className="size-4" style={{ color: p.color, fill: p.color }} />} active={value === p.value} onClick={() => { onChange(p.value); close(); }}>
              {p.label}
            </MenuItem>
          ))}
          <MenuSeparator />
          <MenuItem icon={<X className="size-4" />} onClick={() => { onChange(null); close(); }}>Clear</MenuItem>
        </>
      )}
    </Popover>
  );
}

// ───────────── people ─────────────

export function UserSearchList({ selected, onToggle, multi = true, exclude = [] }: { selected: string[]; onToggle: (id: string) => void; multi?: boolean; exclude?: string[] }) {
  const { data: users = [] } = useUsers();
  const [q, setQ] = useState('');
  const shown = useMemo(
    () => users.filter((u) => !exclude.includes(u.id) && (!q || u.displayName.toLowerCase().includes(q.toLowerCase()) || u.email.toLowerCase().includes(q.toLowerCase()))),
    [users, q, exclude],
  );
  return (
    <div>
      <div className="relative mb-1">
        <Search className="pointer-events-none absolute left-2 top-2 size-4 text-subtle" />
        <Input autoFocus className="pl-7" placeholder="Search people…" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      <div className="max-h-64 overflow-y-auto">
        {shown.map((u) => (
          <MenuItem key={u.id} icon={<Avatar user={u} size={18} />} onClick={() => onToggle(u.id)} right={selected.includes(u.id) ? <Check className="size-4 text-accent-600" /> : null}>
            {u.displayName}
            {u.role === 'guest' && <span className="ml-1 text-xs text-subtle">guest</span>}
          </MenuItem>
        ))}
        {!shown.length && <div className="px-2 py-3 text-center text-sm text-muted">No matches</div>}
        {!multi && null}
      </div>
    </div>
  );
}

export function AssigneePicker({ value, onChange, disabled, size = 22, emptyLabel }: { value: MiniUser[]; onChange: (ids: string[]) => void; disabled?: boolean; size?: number; emptyLabel?: string }) {
  const ids = value.map((u) => u.id);
  const display = value.length ? (
    <AvatarStack users={value} size={size} />
  ) : (
    <span className="inline-flex items-center gap-1 text-subtle">
      <UserPlus className="size-4" />
      {emptyLabel && <span className="text-sm">{emptyLabel}</span>}
    </span>
  );
  if (disabled) return display;
  return (
    <Popover
      width={260}
      trigger={(p) => <button {...p} className="inline-flex items-center rounded px-0.5 hover-bg" title="Assignees">{display}</button>}
    >
      <UserSearchList selected={ids} onToggle={(id) => onChange(ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id])} />
    </Popover>
  );
}

// ───────────── dates ─────────────

export function DueDate({ iso, done, withTime }: { iso: string | null; done?: boolean; withTime?: boolean }) {
  if (!iso) return null;
  return <span className={cx('text-sm', dueTone(iso, !!done))}>{formatDue(iso, withTime)}</span>;
}

export function DatePicker({ value, onChange, disabled, placeholder = 'Due date', done, compact }: { value: string | null; onChange: (iso: string | null) => void; disabled?: boolean; placeholder?: string; done?: boolean; compact?: boolean }) {
  const display = value ? <DueDate iso={value} done={done} /> : compact ? <Calendar className="size-4 text-subtle" /> : <span className="text-sm text-subtle">{placeholder}</span>;
  if (disabled) return display;
  const quick = (days: number) => {
    const d = new Date();
    d.setDate(d.getDate() + days);
    d.setHours(12, 0, 0, 0);
    return d.toISOString();
  };
  return (
    <Popover width={230} trigger={(p) => <button {...p} className="inline-flex items-center rounded px-1 hover-bg">{display}</button>}>
      {(close) => (
        <div className="p-1">
          <Input type="date" defaultValue={toDateInput(value)} onChange={(e) => { if (e.target.value) { onChange(fromDateInput(e.target.value)); close(); } }} />
          <div className="mt-1">
            {[['Today', 0], ['Tomorrow', 1], ['Next week', 7], ['In 2 weeks', 14]].map(([l, n]) => (
              <MenuItem key={l} onClick={() => { onChange(quick(n as number)); close(); }}>{l}</MenuItem>
            ))}
            {value && (
              <>
                <MenuSeparator />
                <MenuItem icon={<X className="size-4" />} onClick={() => { onChange(null); close(); }}>Clear</MenuItem>
              </>
            )}
          </div>
        </div>
      )}
    </Popover>
  );
}

// ───────────── tags ─────────────

export function TagChip({ tag, onRemove }: { tag: Pick<Tag, 'name' | 'color'>; onRemove?: () => void }) {
  return (
    <span className="inline-flex h-5 items-center gap-1 rounded-full px-2 text-[11px] font-medium" style={{ backgroundColor: `${tag.color}26`, color: tag.color }}>
      {tag.name}
      {onRemove && <button onClick={onRemove} aria-label={`Remove ${tag.name}`}><X className="size-3" /></button>}
    </span>
  );
}

const TAG_COLORS = ['#ef4444', '#f97316', '#eab308', '#22c55e', '#14b8a6', '#3b82f6', '#6366f1', '#a855f7', '#ec4899', '#64748b'];

export function TagPicker({ spaceId, value, onChange, disabled }: { spaceId: string; value: Tag[]; onChange: (ids: string[]) => void; disabled?: boolean }) {
  const { data: tags = [] } = useTags(spaceId);
  const qc = useQueryClient();
  const [q, setQ] = useState('');
  const ids = value.map((t) => t.id);
  const chips = (
    <span className="inline-flex flex-wrap items-center gap-1">
      {value.map((t) => <TagChip key={t.id} tag={t} onRemove={disabled ? undefined : () => onChange(ids.filter((x) => x !== t.id))} />)}
    </span>
  );
  if (disabled) return value.length ? chips : <span className="text-sm text-subtle">—</span>;
  const shown = tags.filter((t) => !q || t.name.toLowerCase().includes(q.toLowerCase()));
  const create = async () => {
    const tag = await api.post<Tag>('/tasks/tags', { spaceId, name: q.trim(), color: TAG_COLORS[Math.floor(Math.random() * TAG_COLORS.length)] });
    await qc.invalidateQueries({ queryKey: keys.tags(spaceId) });
    onChange([...ids, tag.id]);
    setQ('');
  };
  return (
    <span className="inline-flex flex-wrap items-center gap-1">
      {chips}
      <Popover width={240} trigger={(p) => <button {...p} className="inline-flex size-5 items-center justify-center rounded text-subtle hover-bg" title="Add tag"><TagIcon className="size-3.5" /></button>}>
        <div>
          <Input autoFocus placeholder="Search or create tag…" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && q.trim() && !shown.some((t) => t.name.toLowerCase() === q.trim().toLowerCase()) && void create()} />
          <div className="mt-1 max-h-56 overflow-y-auto">
            {shown.map((t) => (
              <MenuItem key={t.id} onClick={() => onChange(ids.includes(t.id) ? ids.filter((x) => x !== t.id) : [...ids, t.id])} right={ids.includes(t.id) ? <Check className="size-4" /> : null}>
                <TagChip tag={t} />
              </MenuItem>
            ))}
            {q.trim() && !shown.some((t) => t.name.toLowerCase() === q.trim().toLowerCase()) && (
              <MenuItem icon={<Plus className="size-4" />} onClick={() => void create()}>Create “{q.trim()}”</MenuItem>
            )}
          </div>
        </div>
      </Popover>
    </span>
  );
}

export function ColorSwatches({ value, onChange }: { value: string; onChange: (c: string) => void }) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {TAG_COLORS.map((c) => (
        <button key={c} type="button" onClick={() => onChange(c)} className={cx('size-6 rounded-full ring-offset-2 ring-offset-[var(--bg)]', value === c && 'ring-2 ring-accent-500')} style={{ backgroundColor: c }} aria-label={c} />
      ))}
    </div>
  );
}

export { Button };
