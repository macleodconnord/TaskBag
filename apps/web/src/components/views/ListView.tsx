import { DndContext, DragOverlay, PointerSensor, closestCenter, useDroppable, useSensor, useSensors, type DragEndEvent, type DragStartEvent } from '@dnd-kit/core';
import { SortableContext, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { ChevronDown, ChevronRight, GitFork, GripVertical, ListChecks, Plus } from 'lucide-react';
import { useMemo, useState, type ReactNode } from 'react';
import { useCreateTask, useTasks, useUpdateTask } from '@/lib/queries';
import type { Status, Task } from '@/lib/types';
import { LinkProgressChip } from '@/features/list-links/ListLinks';
import { NewTaskFromTemplateButton } from '@/features/templates/TaskTemplateMenu';
import { AssigneePicker, DatePicker, PriorityPicker, StatusDot, StatusPicker, TagChip } from '../pickers';
import { useOpenTask } from '../task/TaskDrawer';
import { cx, Input, textOn } from '../ui';
import { BulkBar } from './BulkBar';
import { isDone, positionAt, type TaskGroup } from './grouping';

export interface ViewProps {
  tasks: Task[];
  groups: TaskGroup[];
  /** set for a single-list scope: enables inline create and the full status menu */
  listId?: string;
  statuses?: Status[];
  /** drag to reorder (only meaningful when sorted by manual position) */
  reorderable: boolean;
  canCreate: boolean;
  /** extra columns rendered at the end of each row (e.g. custom fields) */
  extraColumns?: Array<{ key: string; header: ReactNode; width: number; cell: (t: Task) => ReactNode }>;
}

export function ListView({ groups, listId, statuses, reorderable, canCreate, extraColumns = [] }: ViewProps) {
  const update = useUpdateTask();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [dragging, setDragging] = useState<Task | null>(null);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));
  const toggleSel = (id: string) => setSelected((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });

  const onDragStart = (e: DragStartEvent) => setDragging(groups.flatMap((g) => g.tasks).find((t) => t.id === e.active.id) ?? null);
  const onDragEnd = (e: DragEndEvent) => {
    setDragging(null);
    const { active, over } = e;
    if (!over) return;
    const fromGroup = groups.find((g) => g.tasks.some((t) => t.id === active.id));
    const overId = String(over.id);
    const toGroup = overId.startsWith('group:') ? groups.find((g) => `group:${g.key}` === overId) : groups.find((g) => g.tasks.some((t) => t.id === overId));
    if (!fromGroup || !toGroup) return;
    const task = fromGroup.tasks.find((t) => t.id === active.id)!;
    const siblings = toGroup.tasks.filter((t) => t.id !== task.id);
    let index = overId.startsWith('group:') ? siblings.length : siblings.findIndex((t) => t.id === overId);
    if (index < 0) index = siblings.length;
    if (fromGroup === toGroup && toGroup.tasks.indexOf(task) < toGroup.tasks.findIndex((t) => t.id === overId)) index += 1;
    const patch: Record<string, unknown> = {};
    if (reorderable) patch.position = positionAt(siblings, index);
    if (fromGroup !== toGroup && toGroup.patch) Object.assign(patch, toGroup.patch);
    if (Object.keys(patch).length) update.mutate({ id: task.id, ...patch });
  };

  const gridCols = `28px minmax(240px,1fr) 110px 110px 90px ${extraColumns.map((c) => `${c.width}px`).join(' ')}`;
  return (
    <div className="pb-24">
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragStart={onDragStart} onDragEnd={onDragEnd} onDragCancel={() => setDragging(null)}>
        {groups.map((g) => (
          <GroupSection key={g.key} group={g} collapsed={collapsed.has(g.key)} onToggle={() => setCollapsed((c) => { const n = new Set(c); if (n.has(g.key)) n.delete(g.key); else n.add(g.key); return n; })}
            gridCols={gridCols} extraColumns={extraColumns}>
            <SortableContext items={g.tasks.map((t) => t.id)} strategy={verticalListSortingStrategy}>
              {g.tasks.map((t) => (
                <SortableRow key={t.id} id={t.id} disabled={!(t._perms.level === 'edit' || t._perms.level === 'full')}>
                  {(handle) => (
                    <TaskRow task={t} statuses={statuses} gridCols={gridCols} extraColumns={extraColumns} handle={handle}
                      selected={selected.has(t.id)} onSelect={() => toggleSel(t.id)} depth={0} />
                  )}
                </SortableRow>
              ))}
            </SortableContext>
            {canCreate && listId && <InlineCreate listId={listId} statusId={g.status?.id} extra={g.patch} gridCols={gridCols} />}
          </GroupSection>
        ))}
        <DragOverlay>{dragging && <div className="rounded-md border border-app bg-app px-3 py-2 text-sm shadow-xl">{dragging.name}</div>}</DragOverlay>
      </DndContext>
      {selected.size > 0 && <BulkBar ids={[...selected]} statuses={statuses} onClear={() => setSelected(new Set())} />}
    </div>
  );
}

function GroupSection({ group, collapsed, onToggle, children, gridCols, extraColumns }: { group: TaskGroup; collapsed: boolean; onToggle: () => void; children: ReactNode; gridCols: string; extraColumns: NonNullable<ViewProps['extraColumns']> }) {
  const { setNodeRef, isOver } = useDroppable({ id: `group:${group.key}` });
  return (
    <section ref={setNodeRef} className={cx('mt-4', isOver && 'rounded-lg bg-accent-50/50 dark:bg-accent-500/5')}>
      <div className="sticky top-0 z-10 grid items-center border-b border-app bg-app px-2 py-1.5 text-xs font-medium text-muted" style={{ gridTemplateColumns: gridCols }}>
        <button onClick={onToggle} className="text-subtle" aria-label={collapsed ? 'Expand group' : 'Collapse group'}>{collapsed ? <ChevronRight className="size-4" /> : <ChevronDown className="size-4" />}</button>
        <div className="flex items-center gap-2">
          {group.status ? (
            <span className="inline-flex h-5 items-center rounded px-2 text-[11px] font-semibold uppercase tracking-wide" style={{ backgroundColor: group.color, color: textOn(group.color) }}>{group.label}</span>
          ) : (
            <span className="font-semibold text-app" style={group.color ? { color: group.color } : undefined}>{group.label}</span>
          )}
          <span>{group.tasks.length}</span>
        </div>
        <div>Assignee</div>
        <div>Due date</div>
        <div>Priority</div>
        {extraColumns.map((c) => <div key={c.key} className="truncate">{c.header}</div>)}
      </div>
      {!collapsed && children}
    </section>
  );
}

function SortableRow({ id, disabled, children }: { id: string; disabled: boolean; children: (handle: Record<string, unknown>) => ReactNode }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id, disabled });
  return (
    <div ref={setNodeRef} style={{ transform: CSS.Transform.toString(transform), transition, opacity: isDragging ? 0.4 : 1 }}>
      {children({ ...attributes, ...listeners })}
    </div>
  );
}

function TaskRow({ task, statuses, gridCols, extraColumns, handle, selected, onSelect, depth }: {
  task: Task; statuses?: Status[]; gridCols: string; extraColumns: NonNullable<ViewProps['extraColumns']>;
  handle?: Record<string, unknown>; selected: boolean; onSelect: () => void; depth: number;
}) {
  const update = useUpdateTask();
  const open = useOpenTask();
  const [expanded, setExpanded] = useState(false);
  const editable = task._perms.level === 'edit' || task._perms.level === 'full';
  const done = isDone(task);
  const rowStatuses = statuses ?? (task.status ? [task.status] : []);
  return (
    <>
      <div className={cx('group grid items-center border-b border-app px-2 py-1 text-sm hover-bg', selected && 'bg-accent-50 dark:bg-accent-500/10')} style={{ gridTemplateColumns: gridCols }}>
        <div className="flex items-center">
          {handle && editable && depth === 0 ? (
            <span {...handle} className="-ml-1 cursor-grab text-subtle opacity-0 group-hover:opacity-100" aria-label="Drag to reorder"><GripVertical className="size-4" /></span>
          ) : <span className="w-3" />}
          <input type="checkbox" className={cx('size-3.5 accent-accent-600', !selected && 'opacity-0 group-hover:opacity-100')} checked={selected} onChange={onSelect} aria-label="Select task" />
        </div>
        <div className="flex min-w-0 items-center gap-2" style={{ paddingLeft: depth * 20 }}>
          {task.subtaskCount > 0 ? (
            <button className="text-subtle hover:text-app" onClick={() => setExpanded(!expanded)} aria-label="Toggle subtasks">{expanded ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}</button>
          ) : <span className="w-3.5" />}
          <StatusPicker statuses={rowStatuses} value={task.statusId} disabled={!editable || !statuses} onChange={(statusId) => update.mutate({ id: task.id, statusId })} trigger={(s) => <StatusDot status={s ?? task.status} size={12} />} />
          <button onClick={() => open(task.key)} className={cx('min-w-0 truncate text-left hover:underline', done && 'text-muted line-through')}>{task.name}</button>
          {task.subtaskCount > 0 && <span className="inline-flex shrink-0 items-center gap-0.5 text-xs text-subtle" title="Subtasks"><GitFork className="size-3" />{task.subtaskDoneCount}/{task.subtaskCount}</span>}
          {task.checklistTotal > 0 && <span className="inline-flex shrink-0 items-center gap-0.5 text-xs text-subtle" title="Checklist"><ListChecks className="size-3" />{task.checklistDone}/{task.checklistTotal}</span>}
          <LinkProgressChip task={task} />
          <span className="flex shrink-0 gap-1">{task.tags.slice(0, 3).map((t) => <TagChip key={t.id} tag={t} />)}</span>
        </div>
        <div><AssigneePicker value={task.assignees} disabled={!editable} onChange={(assigneeIds) => update.mutate({ id: task.id, assigneeIds })} /></div>
        <div><DatePicker compact value={task.dueAt} done={done} disabled={!editable} onChange={(dueAt) => update.mutate({ id: task.id, dueAt })} /></div>
        <div><PriorityPicker value={task.priority} disabled={!editable} onChange={(priority) => update.mutate({ id: task.id, priority })} /></div>
        {extraColumns.map((c) => <div key={c.key} className="min-w-0 truncate">{c.cell(task)}</div>)}
      </div>
      {expanded && <SubtaskRows parent={task} statuses={statuses} gridCols={gridCols} extraColumns={extraColumns} depth={depth + 1} />}
    </>
  );
}

function SubtaskRows({ parent, statuses, gridCols, extraColumns, depth }: { parent: Task; statuses?: Status[]; gridCols: string; extraColumns: NonNullable<ViewProps['extraColumns']>; depth: number }) {
  const { data = [] } = useTasks({ parentTaskId: parent.id });
  const [sel, setSel] = useState<Set<string>>(new Set());
  const sorted = useMemo(() => [...data].sort((a, b) => (a.position < b.position ? -1 : 1)), [data]);
  return (
    <>
      {sorted.map((t) => (
        <TaskRow key={t.id} task={t} statuses={statuses} gridCols={gridCols} extraColumns={extraColumns} selected={sel.has(t.id)}
          onSelect={() => setSel((s) => { const n = new Set(s); if (n.has(t.id)) n.delete(t.id); else n.add(t.id); return n; })} depth={depth} />
      ))}
    </>
  );
}

function InlineCreate({ listId, statusId, extra, gridCols }: { listId: string; statusId?: string; extra?: Record<string, unknown>; gridCols: string }) {
  const create = useCreateTask();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  if (!open) {
    return (
      <div className="flex items-center gap-2 px-2 py-1">
        <button onClick={() => setOpen(true)} className="inline-flex items-center gap-1 rounded px-1.5 py-1 text-sm text-muted hover-bg hover:text-app" style={{ marginLeft: 28 }}>
          <Plus className="size-4" /> New task
        </button>
        <NewTaskFromTemplateButton listId={listId} statusId={statusId} />
      </div>
    );
  }
  return (
    <form className="grid items-center border-b border-app px-2 py-1" style={{ gridTemplateColumns: gridCols }}
      onSubmit={async (e) => {
        e.preventDefault();
        if (!name.trim()) return;
        const assigneeIds = Array.isArray(extra?.assigneeIds) ? (extra!.assigneeIds as string[]) : undefined;
        const priority = typeof extra?.priority === 'number' ? (extra!.priority as number) : undefined;
        await create.mutateAsync({ listId, name: name.trim(), statusId, assigneeIds, priority });
        setName('');
      }}>
      <span />
      <Input autoFocus className="h-7" placeholder="Task name — Enter to save, Esc to cancel" value={name} onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => e.key === 'Escape' && (setOpen(false), setName(''))} onBlur={() => !name && setOpen(false)} />
    </form>
  );
}
