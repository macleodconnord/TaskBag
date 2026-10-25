import { atLeast } from '@app/shared';
import { useQueryClient } from '@tanstack/react-query';
import {
  Archive, ArchiveRestore, Calendar, CheckSquare, ChevronRight, Clock, Copy, Flag, Hash, Link2, MoreHorizontal, Share2, Tag, Trash2, Users,
} from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { Link, useNavigate } from 'react-router';
import { api } from '@/lib/api';
import { formatDate, minutesLabel, parseDuration, timeAgo } from '@/lib/format';
import { refreshTasks, useDeleteTask, useTask, useUpdateTask } from '@/lib/queries';
import type { TaskDetail } from '@/lib/types';
import { TaskFieldsSection } from '@/features/fields/TaskFieldsSection';
import { LinkedListSection } from '@/features/list-links/ListLinks';
import { DevelopmentSection } from '@/features/integrations/DevelopmentSection';
import { SaveTaskAsTemplateItem } from '@/features/templates/TaskTemplateMenu';
import { RichEditor } from '../editor';
import { AssigneePicker, DatePicker, PriorityPicker, StatusPicker, TagPicker } from '../pickers';
import { ShareDialog } from '../ShareDialog';
import { toast } from '../toast';
import { Empty, IconButton, Input, Loading, MenuItem, MenuSeparator, Popover, useDialogs } from '../ui';
import { Attachments } from './Attachments';
import { Checklists } from './Checklists';
import { Comments } from './Comments';
import { Relations } from './Relations';
import { Subtasks } from './Subtasks';

export function TaskDetailView({ taskRef, onDeleted }: { taskRef: string; onDeleted?: () => void }) {
  const { data: task, isLoading, error } = useTask(taskRef);
  if (isLoading) return <Loading />;
  if (error || !task) return <Empty title="Task not found">It may have been deleted, or you don’t have access to it.</Empty>;
  return <TaskDetailBody task={task} onDeleted={onDeleted} />;
}

function TaskDetailBody({ task, onDeleted }: { task: TaskDetail; onDeleted?: () => void }) {
  const update = useUpdateTask();
  const del = useDeleteTask();
  const qc = useQueryClient();
  const nav = useNavigate();
  const { confirm } = useDialogs();
  const [sharing, setSharing] = useState(false);
  const canEdit = atLeast(task.level, 'edit');
  const canComment = atLeast(task.level, 'comment');
  const isFull = task.level === 'full';
  const set = (patch: Parameters<typeof update.mutate>[0] extends infer P ? Omit<P & object, 'id'> : never) => update.mutate({ id: task.id, ...patch });
  const done = task.status?.group === 'done' || task.status?.group === 'closed';

  return (
    <div className="mx-auto max-w-3xl px-6 py-5">
      {/* breadcrumb */}
      <div className="mb-3 flex flex-wrap items-center gap-1 text-xs text-muted">
        {task.path && (
          <>
            <span>{task.path.space.name}</span>
            {task.path.folder && <><ChevronRight className="size-3" /><span>{task.path.folder.name}</span></>}
            <ChevronRight className="size-3" />
            <Link className="hover:text-app hover:underline" to={`/l/${task.path.list.id}`}>{task.path.list.name}</Link>
          </>
        )}
        {task.parent && (
          <>
            <ChevronRight className="size-3" />
            <Link className="hover:text-app hover:underline" to={`?task=${task.parent.key}`}>{task.parent.key} {task.parent.name}</Link>
          </>
        )}
        <span className="ml-auto inline-flex items-center gap-1 font-mono" title="Use this key in Gitea branch names and commits">
          <Hash className="size-3" />{task.key}
          <button className="ml-1 text-subtle hover:text-app" title="Copy link" onClick={() => { void navigator.clipboard.writeText(`${location.origin}/t/${task.key}`); toast.ok('Link copied'); }}><Copy className="size-3" /></button>
        </span>
      </div>

      <div className="flex items-start gap-2">
        <TitleEditor value={task.name} disabled={!canEdit} onSave={(name) => set({ name })} />
        <Popover align="end" width={230} trigger={(p) => <IconButton {...p} label="More actions"><MoreHorizontal className="size-4" /></IconButton>}>
          {(close) => (
            <>
              {canEdit && <MenuItem icon={<Copy className="size-4" />} onClick={async () => { close(); const c = await api.post<{ key: string }>(`/tasks/${task.id}/duplicate`); refreshTasks(qc); nav(`?task=${c.key}`); }}>Duplicate</MenuItem>}
              <SaveTaskAsTemplateItem task={task} onDone={close} />
              {isFull && <MenuItem icon={<Share2 className="size-4" />} onClick={() => { close(); setSharing(true); }}>Sharing & permissions</MenuItem>}
              {canEdit && (task.archivedAt
                ? <MenuItem icon={<ArchiveRestore className="size-4" />} onClick={() => { close(); set({ archived: false }); }}>Unarchive</MenuItem>
                : <MenuItem icon={<Archive className="size-4" />} onClick={() => { close(); set({ archived: true }); toast.ok('Task archived'); }}>Archive</MenuItem>)}
              {isFull && (
                <>
                  <MenuSeparator />
                  <MenuItem danger icon={<Trash2 className="size-4" />} onClick={async () => {
                    close();
                    if (await confirm({ title: 'Delete this task?', body: 'It goes to the trash with its subtasks and is removed permanently after 30 days.', confirm: 'Delete', danger: true })) {
                      await del.mutateAsync(task.id);
                      toast.ok('Task deleted');
                      onDeleted?.();
                    }
                  }}>Delete</MenuItem>
                </>
              )}
            </>
          )}
        </Popover>
      </div>
      {task.archivedAt && <div className="mt-2 rounded-md bg-amber-50 px-3 py-1.5 text-sm text-amber-800 dark:bg-amber-950/40 dark:text-amber-300">This task is archived.</div>}

      {/* properties */}
      <div className="mt-4 grid grid-cols-[120px_1fr] items-center gap-x-3 gap-y-2 text-sm sm:grid-cols-[120px_1fr_120px_1fr]">
        <Prop icon={<CheckSquare className="size-4" />} label="Status">
          <StatusPicker statuses={task.statuses} value={task.statusId} disabled={!canEdit} onChange={(statusId) => set({ statusId })} />
        </Prop>
        <Prop icon={<Users className="size-4" />} label="Assignees">
          <AssigneePicker value={task.assignees} disabled={!canEdit} onChange={(assigneeIds) => set({ assigneeIds })} emptyLabel="Unassigned" />
        </Prop>
        <Prop icon={<Calendar className="size-4" />} label="Start date">
          <DatePicker value={task.startAt} disabled={!canEdit} placeholder="Empty" onChange={(startAt) => set({ startAt })} />
        </Prop>
        <Prop icon={<Calendar className="size-4" />} label="Due date">
          <DatePicker value={task.dueAt} done={done} disabled={!canEdit} placeholder="Empty" onChange={(dueAt) => set({ dueAt })} />
        </Prop>
        <Prop icon={<Flag className="size-4" />} label="Priority">
          <PriorityPicker value={task.priority} showLabel disabled={!canEdit} onChange={(priority) => set({ priority })} />
        </Prop>
        <Prop icon={<Clock className="size-4" />} label="Time estimate">
          <EstimateEditor value={task.timeEstimateMin} disabled={!canEdit} onSave={(timeEstimateMin) => set({ timeEstimateMin })} />
        </Prop>
        <Prop icon={<Tag className="size-4" />} label="Tags" wide>
          {task.path && <TagPicker spaceId={task.path.space.id} value={task.tags} disabled={!canEdit} onChange={(tagIds) => set({ tagIds })} />}
        </Prop>
      </div>

      <TaskFieldsSection task={task} />

      {/* description */}
      <Section title="Description">
        <RichEditor
          value={task.description}
          editable={canEdit}
          placeholder="Add a description… (@ to mention)"
          onCommit={(description) => set({ description })}
          minHeight={80}
          className={!canEdit ? '' : undefined}
        />
        {!canEdit && !task.description && <div className="text-sm text-subtle">No description</div>}
      </Section>

      <LinkedListSection task={task} />
      <Subtasks task={task} canEdit={canEdit} />
      <Checklists task={task} canEdit={canEdit} />
      <Relations task={task} canEdit={canEdit} />
      <Attachments task={task} canEdit={canEdit} />
      <DevelopmentSection task={task} />

      <Section title="Comments">
        <Comments kind="task" id={task.id} canComment={canComment} />
      </Section>

      <div className="mt-6 border-t border-app pt-3 text-xs text-subtle">
        Created {formatDate(task.createdAt, true)}{task.creator ? ` by ${task.creator.displayName}` : ''} · updated {timeAgo(task.updatedAt)}
        {task.source !== 'app' && ` · imported from ${task.source === 'clickup' ? 'ClickUp' : 'NinjaOne'}`}
      </div>

      {sharing && <ShareDialog type="task" id={task.id} name={task.name} onClose={() => setSharing(false)} />}
    </div>
  );
}

function Prop({ icon, label, children, wide }: { icon: ReactNode; label: string; children: ReactNode; wide?: boolean }) {
  return (
    <>
      <div className="flex items-center gap-1.5 text-muted">{icon}{label}</div>
      <div className={wide ? 'sm:col-span-3' : undefined}>{children}</div>
    </>
  );
}

export function Section({ title, children, action, icon }: { title: string; children: ReactNode; action?: ReactNode; icon?: ReactNode }) {
  return (
    <section className="mt-6">
      <div className="mb-2 flex items-center gap-2">
        {icon}
        <h3 className="text-sm font-semibold">{title}</h3>
        <div className="ml-auto">{action}</div>
      </div>
      {children}
    </section>
  );
}

function TitleEditor({ value, onSave, disabled }: { value: string; onSave: (v: string) => void; disabled: boolean }) {
  const [v, setV] = useState(value);
  useEffect(() => setV(value), [value]);
  if (disabled) return <h1 className="flex-1 text-xl font-semibold">{value}</h1>;
  return (
    <textarea
      value={v}
      rows={1}
      onChange={(e) => setV(e.target.value.replace(/\n/g, ''))}
      onBlur={() => v.trim() && v !== value && onSave(v.trim())}
      onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), (e.target as HTMLTextAreaElement).blur())}
      className="flex-1 resize-none rounded-md border border-transparent bg-transparent px-1 text-xl font-semibold hover:border-app focus:border-accent-500 focus:outline-none [field-sizing:content]"
    />
  );
}

function EstimateEditor({ value, onSave, disabled }: { value: number | null; onSave: (v: number | null) => void; disabled: boolean }) {
  const [v, setV] = useState(minutesLabel(value));
  useEffect(() => setV(minutesLabel(value)), [value]);
  if (disabled) return <span>{minutesLabel(value) || <span className="text-subtle">—</span>}</span>;
  return (
    <Input className="h-7 w-28" placeholder="e.g. 1h 30m" value={v} onChange={(e) => setV(e.target.value)}
      onBlur={() => { const m = parseDuration(v); if (m !== value) onSave(m); setV(minutesLabel(m)); }}
      onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()} />
  );
}

