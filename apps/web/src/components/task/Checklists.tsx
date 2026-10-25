import { useQueryClient } from '@tanstack/react-query';
import { CornerDownRight, ListChecks, Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { api } from '@/lib/api';
import { refreshTasks, useUsers } from '@/lib/queries';
import type { ChecklistItem, TaskDetail } from '@/lib/types';
import { Avatar, Button, cx, Input, Popover, useDialogs } from '../ui';
import { UserSearchList } from '../pickers';
import { Section } from './TaskDetailView';

export function Checklists({ task, canEdit }: { task: TaskDetail; canEdit: boolean }) {
  const qc = useQueryClient();
  const { prompt } = useDialogs();
  if (!task.checklists.length && !canEdit) return null;
  const refresh = () => refreshTasks(qc);
  const addChecklist = async () => {
    const name = await prompt({ title: 'New checklist', label: 'Name', initial: 'Checklist', confirm: 'Add' });
    if (name) { await api.post(`/tasks/${task.id}/checklists`, { name }); refresh(); }
  };
  return (
    <Section title="Checklists" action={canEdit && <button className="inline-flex items-center gap-1 text-xs text-muted hover:text-app" onClick={addChecklist}><Plus className="size-3.5" />Add</button>}>
      <div className="space-y-3">
        {task.checklists.map((cl) => {
          const roots = cl.items.filter((i) => !i.parentItemId);
          const done = cl.items.filter((i) => i.resolved).length;
          return (
            <div key={cl.id} className="rounded-lg border border-app">
              <div className="flex items-center gap-2 border-b border-app px-3 py-1.5">
                <ListChecks className="size-4 text-muted" />
                <span className="flex-1 text-sm font-medium">{cl.name}</span>
                <span className="text-xs text-muted">{done}/{cl.items.length}</span>
                {canEdit && <button className="text-subtle hover:text-red-600" aria-label="Delete checklist" onClick={async () => { await api.delete(`/tasks/checklists/${cl.id}`); refresh(); }}><Trash2 className="size-3.5" /></button>}
              </div>
              <div className="py-1">
                {roots.map((it) => (
                  <div key={it.id}>
                    <Item item={it} canEdit={canEdit} onChange={refresh} />
                    {cl.items.filter((c) => c.parentItemId === it.id).map((c) => <Item key={c.id} item={c} nested canEdit={canEdit} onChange={refresh} />)}
                  </div>
                ))}
                {canEdit && <AddItem checklistId={cl.id} onAdded={refresh} parents={roots} />}
              </div>
            </div>
          );
        })}
        {!task.checklists.length && canEdit && <Button size="sm" onClick={addChecklist}><ListChecks className="size-3.5" />Add checklist</Button>}
      </div>
    </Section>
  );
}

function Item({ item, nested, canEdit, onChange }: { item: ChecklistItem; nested?: boolean; canEdit: boolean; onChange: () => void }) {
  const { data: users = [] } = useUsers();
  const assignee = users.find((u) => u.id === item.assigneeId);
  const patch = async (body: Partial<ChecklistItem>) => { await api.patch(`/tasks/checklist-items/${item.id}`, body); onChange(); };
  return (
    <div className={cx('group flex items-center gap-2 px-3 py-1 text-sm', nested && 'pl-9')}>
      <input type="checkbox" className="size-4 accent-accent-600" checked={item.resolved} disabled={!canEdit} onChange={(e) => void patch({ resolved: e.target.checked })} />
      <span className={cx('flex-1', item.resolved && 'text-muted line-through')}>{item.name}</span>
      {canEdit ? (
        <Popover align="end" width={240} trigger={(p) => <button {...p} className={cx(!assignee && 'opacity-0 group-hover:opacity-100')} title="Assign">{assignee ? <Avatar user={assignee} size={18} /> : <span className="text-xs text-subtle">Assign</span>}</button>}>
          {(close) => <UserSearchList selected={item.assigneeId ? [item.assigneeId] : []} onToggle={(id) => { void patch({ assigneeId: id === item.assigneeId ? null : id }); close(); }} />}
        </Popover>
      ) : assignee && <Avatar user={assignee} size={18} />}
      {canEdit && <button className="text-subtle opacity-0 hover:text-red-600 group-hover:opacity-100" aria-label="Delete item" onClick={async () => { await api.delete(`/tasks/checklist-items/${item.id}`); onChange(); }}><Trash2 className="size-3.5" /></button>}
    </div>
  );
}

function AddItem({ checklistId, onAdded, parents }: { checklistId: string; onAdded: () => void; parents: ChecklistItem[] }) {
  const [name, setName] = useState('');
  const [parent, setParent] = useState<string | null>(null);
  return (
    <form className="flex items-center gap-2 px-3 py-1" onSubmit={async (e) => {
      e.preventDefault();
      if (!name.trim()) return;
      await api.post(`/tasks/checklists/${checklistId}/items`, { name: name.trim(), parentItemId: parent });
      setName('');
      onAdded();
    }}>
      <Plus className="size-4 text-subtle" />
      <Input className="h-7 flex-1 border-none px-0 focus:ring-0" placeholder="Add item…" value={name} onChange={(e) => setName(e.target.value)} />
      {parents.length > 0 && name && (
        <select className="h-7 rounded border border-app bg-app text-xs text-muted" value={parent ?? ''} onChange={(e) => setParent(e.target.value || null)} title="Nest under">
          <option value="">Top level</option>
          {parents.map((p) => <option key={p.id} value={p.id}>↳ {p.name.slice(0, 30)}</option>)}
        </select>
      )}
      {parent && <CornerDownRight className="size-3.5 text-subtle" />}
    </form>
  );
}
