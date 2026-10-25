import { DndContext, DragOverlay, PointerSensor, closestCorners, useDroppable, useSensor, useSensors, type DragEndEvent, type DragStartEvent } from '@dnd-kit/core';
import { SortableContext, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { GitFork, ListChecks, Plus } from 'lucide-react';
import { useState } from 'react';
import { useCreateTask, useUpdateTask } from '@/lib/queries';
import type { Task } from '@/lib/types';
import { LinkProgressChip } from '@/features/list-links/ListLinks';
import { AvatarStack, cx, Input } from '../ui';
import { DueDate, PriorityFlag, TagChip } from '../pickers';
import { useOpenTask } from '../task/TaskDrawer';
import { isDone, positionAt, type TaskGroup } from './grouping';
import type { ViewProps } from './ListView';

export function BoardView({ groups, listId, reorderable, canCreate }: ViewProps) {
  const update = useUpdateTask();
  const [dragging, setDragging] = useState<Task | null>(null);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));

  const onDragStart = (e: DragStartEvent) => setDragging(groups.flatMap((g) => g.tasks).find((t) => t.id === e.active.id) ?? null);
  const onDragEnd = (e: DragEndEvent) => {
    setDragging(null);
    const { active, over } = e;
    if (!over) return;
    const overId = String(over.id);
    const from = groups.find((g) => g.tasks.some((t) => t.id === active.id));
    const to = overId.startsWith('col:') ? groups.find((g) => `col:${g.key}` === overId) : groups.find((g) => g.tasks.some((t) => t.id === overId));
    if (!from || !to) return;
    const task = from.tasks.find((t) => t.id === active.id)!;
    const siblings = to.tasks.filter((t) => t.id !== task.id);
    let index = overId.startsWith('col:') ? siblings.length : siblings.findIndex((t) => t.id === overId);
    if (index < 0) index = siblings.length;
    const patch: Record<string, unknown> = {};
    if (reorderable) patch.position = positionAt(siblings, index);
    if (from !== to) {
      if (!to.patch) return; // e.g. tag/list columns: not a drop target for changes
      Object.assign(patch, to.patch);
    }
    if (Object.keys(patch).length) update.mutate({ id: task.id, ...patch });
  };

  return (
    <DndContext sensors={sensors} collisionDetection={closestCorners} onDragStart={onDragStart} onDragEnd={onDragEnd} onDragCancel={() => setDragging(null)}>
      <div className="flex h-full gap-3 overflow-x-auto p-4">
        {groups.map((g) => <Column key={g.key} group={g} listId={listId} canCreate={canCreate} />)}
      </div>
      <DragOverlay>{dragging && <Card task={dragging} overlay />}</DragOverlay>
    </DndContext>
  );
}

function Column({ group, listId, canCreate }: { group: TaskGroup; listId?: string; canCreate: boolean }) {
  const { setNodeRef, isOver } = useDroppable({ id: `col:${group.key}` });
  return (
    <div className="flex w-72 shrink-0 flex-col rounded-xl bg-subtle">
      <div className="flex items-center gap-2 px-3 pb-1 pt-2.5">
        <span className="size-2.5 rounded-full" style={{ backgroundColor: group.color ?? '#94a3b8' }} />
        <span className="truncate text-xs font-semibold uppercase tracking-wide">{group.label}</span>
        <span className="text-xs text-muted" title="Visible tasks in this column">{group.tasks.length}</span>
      </div>
      <div ref={setNodeRef} className={cx('flex min-h-24 flex-1 flex-col gap-2 overflow-y-auto p-2', isOver && 'rounded-lg bg-accent-50/60 dark:bg-accent-500/10')}>
        <SortableContext items={group.tasks.map((t) => t.id)} strategy={verticalListSortingStrategy}>
          {group.tasks.map((t) => <SortableCard key={t.id} task={t} />)}
        </SortableContext>
        {canCreate && listId && <AddCard listId={listId} statusId={group.status?.id} extra={group.patch} />}
      </div>
    </div>
  );
}

function SortableCard({ task }: { task: Task }) {
  const editable = task._perms.level === 'edit' || task._perms.level === 'full';
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: task.id, disabled: !editable });
  return (
    <div ref={setNodeRef} style={{ transform: CSS.Transform.toString(transform), transition, opacity: isDragging ? 0.3 : 1 }} {...attributes} {...listeners}>
      <Card task={task} />
    </div>
  );
}

function Card({ task, overlay }: { task: Task; overlay?: boolean }) {
  const open = useOpenTask();
  const done = isDone(task);
  return (
    <div onClick={() => !overlay && open(task.key)} className={cx('cursor-pointer rounded-lg border border-app bg-app p-2.5 text-sm shadow-sm hover:border-accent-500/50', overlay && 'rotate-2 shadow-xl')}>
      {task.tags.length > 0 && <div className="mb-1.5 flex flex-wrap gap-1">{task.tags.map((t) => <TagChip key={t.id} tag={t} />)}</div>}
      <div className={cx('font-medium', done && 'text-muted line-through')}>{task.name}</div>
      <div className="mt-2 flex items-center gap-2 text-xs text-muted">
        <span className="font-mono">{task.key}</span>
        {task.subtaskCount > 0 && <span className="inline-flex items-center gap-0.5"><GitFork className="size-3" />{task.subtaskDoneCount}/{task.subtaskCount}</span>}
        {task.checklistTotal > 0 && <span className="inline-flex items-center gap-0.5"><ListChecks className="size-3" />{task.checklistDone}/{task.checklistTotal}</span>}
        <LinkProgressChip task={task} />
        <span className="ml-auto flex items-center gap-2">
          <DueDate iso={task.dueAt} done={done} />
          {task.priority && <PriorityFlag value={task.priority} />}
          {task.assignees.length > 0 && <AvatarStack users={task.assignees} size={20} />}
        </span>
      </div>
    </div>
  );
}

function AddCard({ listId, statusId, extra }: { listId: string; statusId?: string; extra?: Record<string, unknown> }) {
  const create = useCreateTask();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  if (!open) return <button onClick={() => setOpen(true)} className="inline-flex items-center gap-1 rounded-md px-2 py-1.5 text-sm text-muted hover-bg hover:text-app"><Plus className="size-4" />Add task</button>;
  return (
    <form onSubmit={async (e) => {
      e.preventDefault();
      if (!name.trim()) return;
      const assigneeIds = Array.isArray(extra?.assigneeIds) ? (extra!.assigneeIds as string[]) : undefined;
      const priority = typeof extra?.priority === 'number' ? (extra!.priority as number) : undefined;
      await create.mutateAsync({ listId, name: name.trim(), statusId, assigneeIds, priority });
      setName('');
    }}>
      <Input autoFocus placeholder="Task name" value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Escape' && setOpen(false)} onBlur={() => !name && setOpen(false)} />
    </form>
  );
}
