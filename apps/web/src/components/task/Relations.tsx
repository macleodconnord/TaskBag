import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Ban, Hourglass, Link2, Plus, Search, X } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { api, qs } from '@/lib/api';
import { refreshTasks } from '@/lib/queries';
import type { TaskDetail, TaskRef } from '@/lib/types';
import { Input, MenuItem, Popover } from '../ui';
import { Section } from './TaskDetailView';
import { useOpenTask } from './TaskDrawer';

/** Dependencies (waiting on / blocking) and linked tasks. */
export function Relations({ task, canEdit }: { task: TaskDetail; canEdit: boolean }) {
  const qc = useQueryClient();
  const open = useOpenTask();
  const empty = !task.waitingOn.length && !task.blocking.length && !task.linkedTasks.length;
  if (empty && !canEdit) return null;
  const refresh = () => refreshTasks(qc);
  const row = (t: TaskRef, icon: ReactNode, onRemove?: () => void) => (
    <div key={t.id} className="group flex items-center gap-2 px-3 py-1.5 text-sm">
      {icon}
      <span className="font-mono text-xs text-muted">{t.key}</span>
      <button className={`flex-1 truncate text-left hover:underline ${t.completedAt ? 'text-muted line-through' : ''}`} onClick={() => open(t.key)}>{t.name}</button>
      {canEdit && onRemove && <button className="text-subtle opacity-0 hover:text-red-600 group-hover:opacity-100" aria-label="Remove" onClick={onRemove}><X className="size-3.5" /></button>}
    </div>
  );
  return (
    <Section
      title="Relationships"
      action={canEdit && (
        <Popover align="end" width={320} trigger={(p) => <button {...p} className="inline-flex items-center gap-1 text-xs text-muted hover:text-app"><Plus className="size-3.5" />Add</button>}>
          {(close) => <AddRelation task={task} onDone={() => { refresh(); close(); }} />}
        </Popover>
      )}
    >
      {!empty && (
        <div className="divide-y divide-[var(--border)] rounded-lg border border-app">
          {task.waitingOn.map((t) => row(t, <Hourglass className="size-4 text-amber-500" aria-label="Waiting on" />, async () => { await api.delete(`/tasks/${task.id}/dependencies/${t.id}`); refresh(); }))}
          {task.blocking.map((t) => row(t, <Ban className="size-4 text-red-500" aria-label="Blocking" />, async () => { await api.delete(`/tasks/${task.id}/dependencies/${t.id}`); refresh(); }))}
          {task.linkedTasks.map((t) => row(t, <Link2 className="size-4 text-muted" aria-label="Linked" />, async () => { await api.delete(`/tasks/${task.id}/links/${t.id}`); refresh(); }))}
        </div>
      )}
      {!empty && (
        <div className="mt-1 flex gap-3 text-[11px] text-subtle">
          {task.waitingOn.length > 0 && <span className="inline-flex items-center gap-1"><Hourglass className="size-3" />waiting on</span>}
          {task.blocking.length > 0 && <span className="inline-flex items-center gap-1"><Ban className="size-3" />blocking</span>}
          {task.linkedTasks.length > 0 && <span className="inline-flex items-center gap-1"><Link2 className="size-3" />linked</span>}
        </div>
      )}
    </Section>
  );
}

function AddRelation({ task, onDone }: { task: TaskDetail; onDone: () => void }) {
  const [kind, setKind] = useState<'waiting' | 'blocking' | 'link'>('waiting');
  const [q, setQ] = useState('');
  const { data = [] } = useQuery({
    queryKey: ['task-search', q],
    queryFn: () => api.get<Array<{ id: string; key: string; name: string }>>(`/tasks${qs({ q, includeClosed: true, includeSubtasks: true, limit: 15 })}`),
    enabled: q.length > 1,
  });
  const pick = async (other: { id: string }) => {
    if (kind === 'waiting') await api.post(`/tasks/${task.id}/dependencies`, { dependsOnTaskId: other.id });
    else if (kind === 'blocking') await api.post(`/tasks/${other.id}/dependencies`, { dependsOnTaskId: task.id });
    else await api.post(`/tasks/${task.id}/links`, { otherTaskId: other.id });
    onDone();
  };
  return (
    <div className="space-y-1">
      <div className="flex gap-1 p-1">
        {([['waiting', 'Waiting on'], ['blocking', 'Blocking'], ['link', 'Link']] as const).map(([k, l]) => (
          <button key={k} onClick={() => setKind(k)} className={`flex-1 rounded px-2 py-1 text-xs font-medium ${kind === k ? 'bg-accent-600 text-white' : 'hover-bg text-muted'}`}>{l}</button>
        ))}
      </div>
      <div className="relative">
        <Search className="pointer-events-none absolute left-2 top-2 size-4 text-subtle" />
        <Input autoFocus className="pl-7" placeholder="Search tasks by name or key…" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      <div className="max-h-64 overflow-y-auto">
        {data.filter((t) => t.id !== task.id).map((t) => (
          <MenuItem key={t.id} onClick={() => void pick(t)}><span className="mr-2 font-mono text-xs text-muted">{t.key}</span>{t.name}</MenuItem>
        ))}
        {q.length > 1 && !data.length && <div className="p-2 text-center text-sm text-muted">No tasks found</div>}
      </div>
    </div>
  );
}
