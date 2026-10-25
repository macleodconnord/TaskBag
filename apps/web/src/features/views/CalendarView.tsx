import type { ViewConfig } from '@app/shared';
import { DndContext, DragOverlay, PointerSensor, pointerWithin, useDraggable, useDroppable, useSensor, useSensors, type DragEndEvent, type DragStartEvent } from '@dnd-kit/core';
import { ChevronLeft, ChevronRight, PanelRightClose, PanelRightOpen, Plus } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useCreateTask, useUpdateTask } from '@/lib/queries';
import type { Task } from '@/lib/types';
import { useOpenTask } from '@/components/task/TaskDrawer';
import { Button, cx, IconButton, Input, Tabs } from '@/components/ui';
import { isDone } from '@/components/views/grouping';
import { canEdit } from './cells';
import { usePref } from './config';
import {
  addDays, addMonths, dayNum, dayOf, diffDays, isoOnDay, monthLabel, sameMonth, shiftIso, shortLabel, startOfMonth, startOfWeek, todayKey,
  weekdayShort, type DayKey,
} from './dates';

type Mode = 'month' | 'week';

/** Calendar (V-06): month/week, tasks on their due (or start) date, drag to reschedule, unscheduled sidebar. */
export function CalendarView({ tasks, config, prefKey, listId, canCreate }: {
  tasks: Task[]; config: ViewConfig; prefKey: string; listId?: string; canCreate: boolean;
}) {
  const [mode, setMode] = usePref<Mode>(`cal-mode:${prefKey}`, 'month');
  const [sidebar, setSidebar] = usePref<'open' | 'closed'>('cal-sidebar', 'open');
  const [anchor, setAnchor] = useState<DayKey>(todayKey());
  const [dragging, setDragging] = useState<Task | null>(null);
  const update = useUpdateTask();
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));
  const prop = config.dateField === 'start_at' ? 'startAt' : 'dueAt';
  const other = prop === 'dueAt' ? 'startAt' : 'dueAt';
  const today = todayKey();

  const days: DayKey[] = useMemo(() => {
    const start = mode === 'month' ? startOfWeek(startOfMonth(anchor)) : startOfWeek(anchor);
    return Array.from({ length: mode === 'month' ? 42 : 7 }, (_, i) => addDays(start, i));
  }, [mode, anchor]);

  const { byDay, unscheduled } = useMemo(() => {
    const m = new Map<DayKey, Task[]>();
    const un: Task[] = [];
    for (const t of tasks) {
      const k = dayOf(t[prop]);
      if (!k) { un.push(t); continue; }
      if (!m.has(k)) m.set(k, []);
      m.get(k)!.push(t);
    }
    return { byDay: m, unscheduled: un };
  }, [tasks, prop]);

  const onDragEnd = (e: DragEndEvent) => {
    setDragging(null);
    const task = tasks.find((t) => t.id === e.active.id);
    const over = e.over ? String(e.over.id) : null;
    if (!task || !over) return;
    if (over === 'unscheduled') {
      if (task[prop]) update.mutate({ id: task.id, [prop]: null });
      return;
    }
    const day = over.slice(4);
    const from = dayOf(task[prop]);
    if (from === day) return;
    const patch: Record<string, string | null> = { [prop]: isoOnDay(day, task[prop]) };
    // keep the task's duration: move the other end by the same number of days
    const otherIso = task[other];
    if (from && otherIso) patch[other] = shiftIso(otherIso, diffDays(day, from));
    else if (!from && otherIso) {
      // scheduling from the sidebar: don't create an inverted range
      const o = dayOf(otherIso)!;
      if ((prop === 'dueAt' && o > day) || (prop === 'startAt' && o < day)) patch[other] = null;
    }
    update.mutate({ id: task.id, ...patch });
  };

  const step = (n: number) => setAnchor(mode === 'month' ? addMonths(anchor, n) : addDays(anchor, 7 * n));
  const title = mode === 'month' ? monthLabel(anchor) : `${shortLabel(days[0])} – ${shortLabel(days[6])}`;

  return (
    <DndContext sensors={sensors} collisionDetection={pointerWithin}
      onDragStart={(e: DragStartEvent) => setDragging(tasks.find((t) => t.id === e.active.id) ?? null)}
      onDragEnd={onDragEnd} onDragCancel={() => setDragging(null)}>
      <div className="flex h-full min-h-0">
        <div className="flex min-w-0 flex-1 flex-col p-4">
          <div className="mb-3 flex items-center gap-2">
            <Button size="sm" onClick={() => setAnchor(today)}>Today</Button>
            <IconButton size="sm" label="Previous" onClick={() => step(-1)}><ChevronLeft className="size-4" /></IconButton>
            <IconButton size="sm" label="Next" onClick={() => step(1)}><ChevronRight className="size-4" /></IconButton>
            <h2 className="text-sm font-semibold">{title}</h2>
            <span className="text-xs text-subtle">by {config.dateField === 'start_at' ? 'start date' : 'due date'}</span>
            <div className="ml-auto flex items-center gap-2">
              <Tabs value={mode} onChange={setMode} items={[{ value: 'month', label: 'Month' }, { value: 'week', label: 'Week' }]} />
              <IconButton size="sm" label={sidebar === 'open' ? 'Hide unscheduled' : 'Show unscheduled'} onClick={() => setSidebar(sidebar === 'open' ? 'closed' : 'open')}>
                {sidebar === 'open' ? <PanelRightClose className="size-4" /> : <PanelRightOpen className="size-4" />}
              </IconButton>
            </div>
          </div>
          <div className="grid grid-cols-7 border-l border-t border-app text-xs font-medium text-muted">
            {days.slice(0, 7).map((d) => <div key={d} className="border-b border-r border-app bg-subtle px-2 py-1">{weekdayShort(d)}</div>)}
          </div>
          <div className={cx('grid min-h-0 flex-1 grid-cols-7 border-l border-app', mode === 'month' ? 'grid-rows-6' : 'grid-rows-1')}>
            {days.map((d) => (
              <DayCell key={d} day={d} tasks={byDay.get(d) ?? []} today={d === today} dim={mode === 'month' && !sameMonth(d, anchor)} tall={mode === 'week'}
                createIn={canCreate ? listId : undefined} prop={prop} />
            ))}
          </div>
        </div>
        {sidebar === 'open' && <Unscheduled tasks={unscheduled} label={config.dateField === 'start_at' ? 'No start date' : 'No due date'} />}
      </div>
      <DragOverlay dropAnimation={null}>{dragging && <Chip task={dragging} overlay />}</DragOverlay>
    </DndContext>
  );
}

function DayCell({ day, tasks, today, dim, tall, createIn, prop }: { day: DayKey; tasks: Task[]; today: boolean; dim: boolean; tall: boolean; createIn?: string; prop: 'dueAt' | 'startAt' }) {
  const { setNodeRef, isOver } = useDroppable({ id: `day:${day}` });
  const [adding, setAdding] = useState(false);
  return (
    <div ref={setNodeRef} className={cx('group flex min-h-0 flex-col border-b border-r border-app', dim && 'bg-subtle', isOver && 'bg-accent-50 dark:bg-accent-500/10')} data-day={day}>
      <div className="flex items-center justify-between px-1.5 pt-1">
        <span className={cx('inline-flex size-6 items-center justify-center rounded-full text-xs', today ? 'bg-accent-600 font-semibold text-white' : dim ? 'text-subtle' : 'text-muted')}>{dayNum(day)}</span>
        {!tall && tasks.length > 3 && <span className="ml-auto mr-1 text-[10px] text-subtle" title="Scroll the day to see all">{tasks.length} tasks</span>}
        {createIn && !adding && (
          <button className="rounded p-0.5 text-subtle opacity-0 hover-bg hover:text-app group-hover:opacity-100" onClick={() => setAdding(true)} aria-label={`Add task on ${day}`}><Plus className="size-3.5" /></button>
        )}
      </div>
      <div className={cx('flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto px-1 pb-1', tall ? 'pt-1' : '')}>
        {tasks.map((t) => <DraggableChip key={t.id} task={t} />)}
        {adding && createIn && <QuickAdd listId={createIn} day={day} prop={prop} onClose={() => setAdding(false)} />}
      </div>
    </div>
  );
}

function QuickAdd({ listId, day, prop, onClose }: { listId: string; day: DayKey; prop: 'dueAt' | 'startAt'; onClose: () => void }) {
  const create = useCreateTask();
  const [name, setName] = useState('');
  return (
    <form onSubmit={async (e) => {
      e.preventDefault();
      if (!name.trim()) return;
      await create.mutateAsync({ listId, name: name.trim(), [prop]: isoOnDay(day) });
      setName('');
      onClose();
    }}>
      <Input autoFocus className="h-6 text-xs" placeholder="Task name" value={name} onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => e.key === 'Escape' && onClose()} onBlur={() => !name && onClose()} />
    </form>
  );
}

function DraggableChip({ task }: { task: Task }) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({ id: task.id, disabled: !canEdit(task) });
  return (
    <div ref={setNodeRef} {...attributes} {...listeners} style={{ opacity: isDragging ? 0.3 : 1 }}>
      <Chip task={task} />
    </div>
  );
}

function Chip({ task, overlay }: { task: Task; overlay?: boolean }) {
  const open = useOpenTask();
  const done = isDone(task);
  return (
    <div onClick={() => !overlay && open(task.key)} title={`${task.key} · ${task.name}`}
      className={cx('flex cursor-pointer items-center gap-1 truncate rounded border border-app bg-app px-1.5 py-0.5 text-xs shadow-sm hover:border-accent-500/60',
        overlay && 'w-48 shadow-lg', done && 'text-muted line-through')}
      style={{ borderLeft: `3px solid ${task.status?.color ?? '#94a3b8'}` }}>
      <span className="truncate">{task.name}</span>
    </div>
  );
}

function Unscheduled({ tasks, label }: { tasks: Task[]; label: string }) {
  const { setNodeRef, isOver } = useDroppable({ id: 'unscheduled' });
  const [q, setQ] = useState('');
  const shown = tasks.filter((t) => !q || t.name.toLowerCase().includes(q.toLowerCase()));
  return (
    <aside ref={setNodeRef} className={cx('flex w-60 shrink-0 flex-col border-l border-app bg-subtle', isOver && 'bg-accent-50 dark:bg-accent-500/10')} aria-label="Unscheduled tasks">
      <div className="px-3 pb-2 pt-3">
        <div className="text-xs font-semibold uppercase tracking-wide text-muted">Unscheduled <span className="font-normal">{tasks.length}</span></div>
        <div className="mb-2 text-xs text-subtle">{label} · drag onto a day</div>
        <Input className="h-7 text-xs" placeholder="Filter…" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto px-3 pb-3">
        {shown.map((t) => <DraggableChip key={t.id} task={t} />)}
        {!shown.length && <div className="py-4 text-center text-xs text-subtle">Nothing unscheduled</div>}
      </div>
    </aside>
  );
}
