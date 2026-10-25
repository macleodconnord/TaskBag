import { Plus } from 'lucide-react';
import { useState } from 'react';
import { useCreateTask, useUpdateTask } from '@/lib/queries';
import type { TaskDetail } from '@/lib/types';
import { AssigneePicker, DatePicker, StatusPicker } from '../pickers';
import { Input } from '../ui';
import { Section } from './TaskDetailView';
import { useOpenTask } from './TaskDrawer';

export function Subtasks({ task, canEdit }: { task: TaskDetail; canEdit: boolean }) {
  const create = useCreateTask();
  const update = useUpdateTask();
  const open = useOpenTask();
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');
  if (!task.subtasks.length && !canEdit) return null;
  const doneCount = task.subtasks.filter((s) => s.completedAt).length;
  const submit = async () => {
    if (!name.trim()) return;
    await create.mutateAsync({ listId: task.listId, parentTaskId: task.id, name: name.trim() });
    setName('');
  };
  return (
    <Section
      title={`Subtasks${task.subtasks.length ? ` (${doneCount}/${task.subtasks.length})` : ''}`}
      action={canEdit && !adding && <button className="inline-flex items-center gap-1 text-xs text-muted hover:text-app" onClick={() => setAdding(true)}><Plus className="size-3.5" />Add</button>}
    >
      <div className="divide-y divide-[var(--border)] rounded-lg border border-app empty:hidden">
        {task.subtasks.map((s) => {
          const editable = s._perms.level === 'edit' || s._perms.level === 'full';
          return (
            <div key={s.id} className="flex items-center gap-2 px-3 py-1.5 text-sm">
              <StatusPicker statuses={task.statuses} value={s.statusId} disabled={!editable} onChange={(statusId) => update.mutate({ id: s.id, statusId })}
                trigger={(st) => <span className="size-3 rounded-full" style={{ backgroundColor: st?.color }} title={st?.name} />} />
              <button className={`flex-1 truncate text-left hover:underline ${s.completedAt ? 'text-muted line-through' : ''}`} onClick={() => open(s.key)}>{s.name}</button>
              {s.subtaskCount > 0 && <span className="text-xs text-subtle">{s.subtaskDoneCount}/{s.subtaskCount}</span>}
              <DatePicker compact value={s.dueAt} done={!!s.completedAt} disabled={!editable} onChange={(dueAt) => update.mutate({ id: s.id, dueAt })} />
              <AssigneePicker value={s.assignees} disabled={!editable} size={20} onChange={(assigneeIds) => update.mutate({ id: s.id, assigneeIds })} />
            </div>
          );
        })}
        {adding && (
          <form className="flex items-center gap-2 px-3 py-1.5" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
            <Plus className="size-4 text-subtle" />
            <Input autoFocus className="h-7 border-none px-0 focus:ring-0" placeholder="Subtask name, Enter to add, Esc to stop" value={name}
              onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Escape' && setAdding(false)} onBlur={() => !name && setAdding(false)} />
          </form>
        )}
      </div>
    </Section>
  );
}
