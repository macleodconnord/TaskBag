import { useQueryClient } from '@tanstack/react-query';
import { LayoutTemplate } from 'lucide-react';
import { useOpenTask } from '@/components/task/TaskDrawer';
import { MenuItem } from '@/components/ui';
import { api } from '@/lib/api';
import { refreshTasks, useMe } from '@/lib/queries';
import type { Task, TaskDetail } from '@/lib/types';
import { openSaveTemplate, openTemplatePicker } from './TemplatePicker';

/** Task detail "⋯" menu item: save this task as a template. Hidden for guests. */
export function SaveTaskAsTemplateItem({ task, onDone }: { task: TaskDetail; onDone: () => void }) {
  const { data: me } = useMe();
  if (!me || me.user.role === 'guest') return null;
  return (
    <MenuItem icon={<LayoutTemplate className="size-4" />} onClick={() => { onDone(); openSaveTemplate({ kind: 'task', sourceId: task.id, defaultName: task.name }); }}>
      Save as template
    </MenuItem>
  );
}

/** Button next to inline task creation: create a task from a template. Hidden for guests. */
export function NewTaskFromTemplateButton({ listId, statusId }: { listId: string; statusId?: string }) {
  const { data: me } = useMe();
  const qc = useQueryClient();
  const openTask = useOpenTask();
  if (!me || me.user.role === 'guest') return null;
  const pick = () => openTemplatePicker({
    kind: 'task',
    title: 'New task from template',
    confirmLabel: 'Create task',
    askName: true,
    onPick: async (t, name) => {
      const task = await api.post<Task>(`/templates/${t.id}/apply`, { listId, statusId, name });
      refreshTasks(qc);
      openTask(task.key);
    },
  });
  return (
    <button onClick={pick} className="inline-flex items-center gap-1 rounded px-1.5 py-1 text-sm text-muted hover-bg hover:text-app" title="Create a task from a template">
      <LayoutTemplate className="size-4" /> From template
    </button>
  );
}
