import type { ViewConfig } from '@app/shared';
import { ArrowDown, ArrowUp, ChevronDown, ChevronRight, Plus } from 'lucide-react';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { FieldValueCell, type CustomField } from '@/features/fields/public';
import { formatDate } from '@/lib/format';
import { useCreateTask, useUpdateTask } from '@/lib/queries';
import type { Status, Task } from '@/lib/types';
import { AssigneePicker, DatePicker, PriorityPicker, StatusDot, TagPicker, TagChip } from '@/components/pickers';
import { useOpenTask } from '@/components/task/TaskDrawer';
import { cx, Input, textOn } from '@/components/ui';
import { BulkBar } from '@/components/views/BulkBar';
import { isDone, type TaskGroup } from '@/components/views/grouping';
import type { ScopeType } from './api';
import { canEdit, TaskStatusPicker, useListIndex } from './cells';
import { MIN_COL, NAME_WIDTH, visibleColumns, type ColumnDef } from './config';

const ROW_H = 36;
const SEL_W = 36;
const OVERSCAN = 8;
const SORTABLE = new Set(['status', 'priority', 'due_at', 'start_at', 'created_at', 'updated_at', 'key']);

/** Row background as a variable so the sticky (frozen) cells match hover/selection. */
const ROW_PLAIN = '[--row-bg:var(--bg)] hover:[--row-bg:var(--bg-hover)]';
const ROW_SELECTED = '[--row-bg:#eef2ff] dark:[--row-bg:#1e1b4b]';

type Item = { kind: 'group'; group: TaskGroup; collapsed: boolean } | { kind: 'task'; task: Task };

export interface TableViewProps {
  groups: TaskGroup[];
  statuses?: Status[];
  listId?: string;
  canCreate: boolean;
  scope: ScopeType;
  fields: CustomField[];
  config: ViewConfig;
  onConfig: (p: Partial<ViewConfig>) => void;
}

/** Spreadsheet-like grid (V-05). Rows are windowed so thousands of tasks stay smooth. */
export function TableView({ groups, statuses, listId, canCreate, scope, fields, config, onConfig }: TableViewProps) {
  const cols = useMemo(() => visibleColumns(config, scope, fields), [config, scope, fields]);
  const [liveWidths, setLiveWidths] = useState<Record<string, number>>({});
  const width = (c: { key: string; width: number }) => liveWidths[c.key] ?? c.width;
  const nameW = liveWidths.name ?? config.columnWidths.name ?? NAME_WIDTH;
  const template = `${SEL_W}px ${nameW}px ${cols.map((c) => `${width(c)}px`).join(' ')} minmax(40px,1fr)`;
  const totalW = SEL_W + nameW + cols.reduce((n, c) => n + width(c), 0) + 40;

  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const grouped = !(groups.length === 1 && groups[0].key === 'all');
  const items: Item[] = useMemo(() => {
    const out: Item[] = [];
    for (const g of groups) {
      if (grouped) {
        if (!g.tasks.length) continue;
        out.push({ kind: 'group', group: g, collapsed: collapsed.has(g.key) });
        if (collapsed.has(g.key)) continue;
      }
      for (const t of g.tasks) out.push({ kind: 'task', task: t });
    }
    return out;
  }, [groups, grouped, collapsed]);
  const allTasks = useMemo(() => groups.flatMap((g) => g.tasks), [groups]);

  // ── windowing ──
  const scroller = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewH, setViewH] = useState(800);
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setViewH(el.clientHeight));
    ro.observe(el);
    setViewH(el.clientHeight);
    return () => ro.disconnect();
  }, []);
  const first = Math.max(0, Math.floor(scrollTop / ROW_H) - OVERSCAN);
  const last = Math.min(items.length, Math.ceil((scrollTop + viewH) / ROW_H) + OVERSCAN);

  // ── selection ──
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const toggleSel = (id: string) => setSelected((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const allSelected = allTasks.length > 0 && allTasks.every((t) => selected.has(t.id));

  // ── keyboard navigation (active cell) ──
  const [active, setActive] = useState<{ row: number; col: number } | null>(null);
  const [editingName, setEditingName] = useState<string | null>(null);
  const colCount = cols.length + 1; // name + columns
  useEffect(() => {
    if (active && active.row >= items.length) setActive(items.length ? { row: items.length - 1, col: active.col } : null);
  }, [items.length, active]);

  const scrollIntoView = useCallback((row: number) => {
    const el = scroller.current;
    if (!el) return;
    const top = row * ROW_H;
    const headerH = ROW_H;
    if (top < el.scrollTop) el.scrollTop = top;
    else if (top + ROW_H > el.scrollTop + el.clientHeight - headerH) el.scrollTop = top + ROW_H - el.clientHeight + headerH;
  }, []);

  const moveRow = (from: number, dir: 1 | -1) => {
    let r = from + dir;
    while (r >= 0 && r < items.length && items[r].kind !== 'task') r += dir;
    return r >= 0 && r < items.length ? r : from;
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const target = e.target as HTMLElement;
    if (target.closest('[data-popover]') || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName) || target.isContentEditable) return;
    if (!items.length) return;
    const cur = active ?? { row: moveRow(-1, 1), col: 0 };
    let next = cur;
    switch (e.key) {
      case 'ArrowDown': next = { ...cur, row: active ? moveRow(cur.row, 1) : cur.row }; break;
      case 'ArrowUp': next = { ...cur, row: moveRow(cur.row, -1) }; break;
      case 'ArrowRight': next = { ...cur, col: Math.min(colCount - 1, cur.col + 1) }; break;
      case 'ArrowLeft': next = { ...cur, col: Math.max(0, cur.col - 1) }; break;
      case 'Home': next = { ...cur, col: 0 }; break;
      case 'End': next = { ...cur, col: colCount - 1 }; break;
      case 'Enter': {
        e.preventDefault();
        const item = items[cur.row];
        if (item?.kind !== 'task') return;
        if (cur.col === 0) {
          if (e.shiftKey || !canEdit(item.task)) document.querySelector<HTMLElement>(`[data-cell="${cur.row}:0"] [data-open]`)?.click();
          else setEditingName(item.task.id);
        } else {
          const cell = document.querySelector<HTMLElement>(`[data-cell="${cur.row}:${cur.col}"]`);
          cell?.querySelector<HTMLElement>('button, input, [tabindex]:not([tabindex="-1"])')?.click();
        }
        return;
      }
      case ' ': {
        const item = items[cur.row];
        if (item?.kind === 'task') { e.preventDefault(); toggleSel(item.task.id); }
        return;
      }
      case 'Escape': setActive(null); return;
      default: return;
    }
    e.preventDefault();
    setActive(next);
    scrollIntoView(next.row);
    scroller.current?.focus({ preventScroll: true });
  };

  // ── column resize ──
  const startResize = (key: string, startW: number) => (e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const x0 = e.clientX;
    let w = startW;
    const onMove = (ev: PointerEvent) => {
      w = Math.max(MIN_COL, Math.round(startW + ev.clientX - x0));
      setLiveWidths((m) => ({ ...m, [key]: w }));
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      if (w !== startW) onConfig({ columnWidths: { ...config.columnWidths, [key]: w } });
      setLiveWidths((m) => { const n = { ...m }; delete n[key]; return n; });
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  const sortDir = (key: string) => (config.sort[0]?.field === key ? config.sort[0].dir : null);
  const clickHeader = (key: string) => {
    if (!SORTABLE.has(key) && key !== 'name' && !key.startsWith('cf:')) return;
    const d = sortDir(key);
    onConfig({ sort: d === 'asc' ? [{ field: key, dir: 'desc' }] : d === 'desc' ? [] : [{ field: key, dir: 'asc' }] });
  };

  const listIndex = useListIndex();

  return (
    <div className="flex h-full flex-col">
      <div ref={scroller} tabIndex={0} onKeyDown={onKeyDown} onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
        className="relative min-h-0 flex-1 overflow-auto outline-none" role="grid" aria-rowcount={items.length} aria-label="Tasks table">
        <div style={{ width: totalW, minWidth: '100%' }}>
          {/* header */}
          <div className="sticky top-0 z-20 grid border-b border-app bg-subtle text-xs font-medium text-muted" style={{ gridTemplateColumns: template, height: ROW_H }} role="row">
            <div className="sticky left-0 z-10 flex items-center justify-center bg-subtle">
              <input type="checkbox" className="size-3.5 accent-accent-600" checked={allSelected} aria-label="Select all"
                onChange={() => setSelected(allSelected ? new Set() : new Set(allTasks.map((t) => t.id)))} />
            </div>
            <HeaderCell label="Task" sticky dir={sortDir('name')} onClick={() => clickHeader('name')} onResize={startResize('name', nameW)} />
            {cols.map((c) => (
              <HeaderCell key={c.key} label={c.label} dir={sortDir(c.key)} sortable={SORTABLE.has(c.key) || !!c.field}
                onClick={() => clickHeader(c.key)} onResize={startResize(c.key, width(c))} />
            ))}
            <div />
          </div>
          {/* body (windowed) */}
          <div className="relative" style={{ height: items.length * ROW_H }}>
            {items.slice(first, last).map((item, i) => {
              const row = first + i;
              const top = row * ROW_H;
              if (item.kind === 'group') {
                const g = item.group;
                return (
                  <div key={`g:${g.key}`} className="absolute left-0 flex w-full items-center gap-2 border-b border-app bg-app px-2 text-xs font-medium" style={{ top, height: ROW_H }}>
                    <button className="sticky left-2 flex items-center gap-2" onClick={() => setCollapsed((c) => { const n = new Set(c); if (n.has(g.key)) n.delete(g.key); else n.add(g.key); return n; })}>
                      {item.collapsed ? <ChevronRight className="size-4 text-subtle" /> : <ChevronDown className="size-4 text-subtle" />}
                      {g.status ? (
                        <span className="inline-flex h-5 items-center rounded px-2 text-[11px] font-semibold uppercase tracking-wide" style={{ backgroundColor: g.color, color: textOn(g.color) }}>{g.label}</span>
                      ) : <span className="font-semibold text-app" style={g.color ? { color: g.color } : undefined}>{g.label}</span>}
                      <span className="text-muted">{g.tasks.length}</span>
                    </button>
                  </div>
                );
              }
              return (
                <TaskRow key={item.task.id} task={item.task} row={row} top={top} template={template} cols={cols} statuses={statuses}
                  spaceId={listIndex.get(item.task.listId)?.spaceId} listName={listIndex.get(item.task.listId)?.name}
                  selected={selected.has(item.task.id)} onSelect={() => toggleSel(item.task.id)}
                  activeCol={active?.row === row ? active.col : null} onActivate={(col) => setActive({ row, col })}
                  editingName={editingName === item.task.id} onEditName={(on) => { setEditingName(on ? item.task.id : null); if (!on) scroller.current?.focus({ preventScroll: true }); }} />
              );
            })}
          </div>
          {canCreate && listId && <AddRow listId={listId} template={template} />}
          {!items.length && !canCreate && <div className="p-8 text-center text-sm text-muted">No tasks match this view.</div>}
        </div>
      </div>
      {selected.size > 0 && <BulkBar ids={[...selected]} statuses={statuses} onClear={() => setSelected(new Set())} />}
    </div>
  );
}

function HeaderCell({ label, sticky, dir, sortable = true, onClick, onResize }: {
  label: string; sticky?: boolean; dir: 'asc' | 'desc' | null; sortable?: boolean; onClick: () => void; onResize: (e: React.PointerEvent) => void;
}) {
  return (
    <div className={cx('group relative flex min-w-0 items-center border-r border-app px-2', sticky && 'sticky z-10 bg-subtle')} style={sticky ? { left: SEL_W } : undefined} role="columnheader">
      <button className={cx('flex min-w-0 items-center gap-1 truncate', sortable ? 'hover:text-app' : 'cursor-default')} onClick={onClick} title={sortable ? 'Sort' : undefined}>
        <span className="truncate">{label}</span>
        {dir === 'asc' && <ArrowUp className="size-3 shrink-0" />}
        {dir === 'desc' && <ArrowDown className="size-3 shrink-0" />}
      </button>
      <span onPointerDown={onResize} className="absolute -right-1 top-0 z-10 h-full w-2 cursor-col-resize opacity-0 hover:bg-accent-500/40 group-hover:opacity-100" aria-label={`Resize ${label}`} role="separator" />
    </div>
  );
}

function TaskRow({ task, row, top, template, cols, statuses, spaceId, listName, selected, onSelect, activeCol, onActivate, editingName, onEditName }: {
  task: Task; row: number; top: number; template: string; cols: ColumnDef[]; statuses?: Status[]; spaceId?: string; listName?: string;
  selected: boolean; onSelect: () => void; activeCol: number | null; onActivate: (col: number) => void; editingName: boolean; onEditName: (on: boolean) => void;
}) {
  const update = useUpdateTask();
  const open = useOpenTask();
  const editable = canEdit(task);
  const done = isDone(task);
  const patch = (p: Record<string, unknown>) => update.mutate({ id: task.id, ...p });
  const cellCls = (col: number) => cx('flex min-w-0 items-center overflow-hidden whitespace-nowrap border-r border-app px-2',
    activeCol === col && 'outline outline-2 -outline-offset-2 outline-accent-500');

  const cell = (c: ColumnDef): ReactNode => {
    switch (c.key) {
      case 'status': return <TaskStatusPicker task={task} statuses={statuses} onChange={(statusId) => patch({ statusId })} />;
      case 'assignees': return <AssigneePicker value={task.assignees} disabled={!editable} onChange={(assigneeIds) => patch({ assigneeIds })} />;
      case 'due_at': return <DatePicker value={task.dueAt} done={done} disabled={!editable} placeholder="—" onChange={(dueAt) => patch({ dueAt })} />;
      case 'start_at': return <DatePicker value={task.startAt} disabled={!editable} placeholder="—" onChange={(startAt) => patch({ startAt })} />;
      case 'priority': return <PriorityPicker value={task.priority} disabled={!editable} showLabel onChange={(priority) => patch({ priority })} />;
      case 'tags':
        return spaceId && editable
          ? <TagPicker spaceId={spaceId} value={task.tags} onChange={(tagIds) => patch({ tagIds })} />
          : <span className="flex gap-1">{task.tags.map((t) => <TagChip key={t.id} tag={t} />)}</span>;
      case 'list': return <span className="truncate text-muted">{listName ?? '—'}</span>;
      case 'key': return <span className="font-mono text-xs text-muted">{task.key}</span>;
      case 'created_at': return <span className="text-muted">{formatDate(task.createdAt)}</span>;
      case 'updated_at': return <span className="text-muted">{formatDate(task.updatedAt)}</span>;
      default: return c.field ? <FieldValueCell field={c.field} task={task} editable={editable} /> : null;
    }
  };

  return (
    <div role="row" className={cx('group absolute left-0 grid w-full border-b border-app bg-[var(--row-bg)] text-sm', selected ? ROW_SELECTED : ROW_PLAIN)}
      style={{ top, height: ROW_H, gridTemplateColumns: template }}>
      <div className="sticky left-0 z-[1] flex items-center justify-center bg-[var(--row-bg)]">
        <input type="checkbox" className={cx('size-3.5 accent-accent-600', !selected && 'opacity-0 group-hover:opacity-100 focus:opacity-100')} checked={selected} onChange={onSelect} aria-label="Select task" tabIndex={-1} />
      </div>
      <div data-cell={`${row}:0`} role="gridcell" onMouseDown={() => onActivate(0)}
        className={cx(cellCls(0), 'sticky z-[1] gap-2 bg-[var(--row-bg)]')} style={{ left: SEL_W }}>
        <TaskStatusPicker task={task} statuses={statuses} onChange={(statusId) => patch({ statusId })} trigger={(s) => <StatusDot status={s} size={12} />} />
        {editingName ? (
          <NameEditor initial={task.name} onDone={(name) => { if (name && name !== task.name) patch({ name }); onEditName(false); }} />
        ) : (
          <button data-open onClick={() => open(task.key)} onDoubleClick={(e) => { if (editable) { e.preventDefault(); onEditName(true); } }}
            className={cx('min-w-0 truncate text-left hover:underline', done && 'text-muted line-through')} title={editable ? 'Click to open · double-click or Enter to rename' : undefined}>
            {task.parentTaskId && <span className="mr-1 text-subtle">↳</span>}{task.name}
          </button>
        )}
      </div>
      {cols.map((c, i) => (
        <div key={c.key} data-cell={`${row}:${i + 1}`} role="gridcell" className={cellCls(i + 1)} onMouseDown={() => onActivate(i + 1)}>{cell(c)}</div>
      ))}
      <div />
    </div>
  );
}

function NameEditor({ initial, onDone }: { initial: string; onDone: (name: string | null) => void }) {
  const [v, setV] = useState(initial);
  const done = useRef(false);
  const finish = (val: string | null) => { if (done.current) return; done.current = true; onDone(val); };
  return (
    <Input autoFocus className="h-7" value={v} onChange={(e) => setV(e.target.value)} onFocus={(e) => e.currentTarget.select()}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Enter') finish(v.trim() || null);
        if (e.key === 'Escape') finish(null);
      }}
      onBlur={() => finish(v.trim() || null)} />
  );
}

function AddRow({ listId, template }: { listId: string; template: string }) {
  const create = useCreateTask();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  if (!open) {
    return (
      <div className="sticky left-0 w-fit px-2 py-1">
        <button onClick={() => setOpen(true)} className="inline-flex items-center gap-1 rounded px-1.5 py-1 text-sm text-muted hover-bg hover:text-app" style={{ marginLeft: SEL_W - 8 }}>
          <Plus className="size-4" /> New task
        </button>
      </div>
    );
  }
  return (
    <form className="grid items-center border-b border-app py-1" style={{ gridTemplateColumns: template }}
      onSubmit={async (e) => {
        e.preventDefault();
        if (!name.trim()) return;
        await create.mutateAsync({ listId, name: name.trim() });
        setName('');
      }}>
      <span />
      <Input autoFocus className="h-7" placeholder="Task name — Enter to save, Esc to cancel" value={name} onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Escape') { setOpen(false); setName(''); } }} onBlur={() => !name && setOpen(false)} />
    </form>
  );
}
