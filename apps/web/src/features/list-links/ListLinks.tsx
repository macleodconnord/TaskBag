import { atLeast } from '@app/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { CornerLeftUp, ExternalLink, Lock, Network, Plus, Search, Unlink } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router';
import { StatusDot } from '@/components/pickers';
import { useOpenTask } from '@/components/task/TaskDrawer';
import { toast } from '@/components/toast';
import { cx, Input, MenuItem, MenuSeparator, Popover, useDialogs } from '@/components/ui';
import { api } from '@/lib/api';
import { minutesLabel } from '@/lib/format';
import { refreshTasks } from '@/lib/queries';
import type { ListDetail, Status, Task, TaskDetail } from '@/lib/types';

type Rollup = { hidden: true } | { hidden: false; listId: string; name: string; total: number; done: number; estimateMin: number };
type DetailLink =
  | { hidden: true }
  | (Extract<Rollup, { hidden: false }> & {
    level: string;
    preview: Array<{ id: string; key: string; name: string; completedAt: string | null; status: Pick<Status, 'id' | 'name' | 'color' | 'group'> | null }>;
  });
type Owner = { id: string; key: string; name: string; completedAt: string | null; listId: string; listName: string | null } | null;

const pct = (done: number, total: number) => (total ? Math.round((done / total) * 100) : 0);

function ProgressBar({ done, total }: { done: number; total: number }) {
  return (
    <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
      <span className="block h-full rounded-full bg-emerald-500 transition-[width]" style={{ width: `${pct(done, total)}%` }} />
    </span>
  );
}

/** Task detail section: the List this task is linked to (rollup), or a "Link a list" action. */
export function LinkedListSection({ task }: { task: TaskDetail }) {
  const qc = useQueryClient();
  const open = useOpenTask();
  const { confirm } = useDialogs();
  const link = (task.linkedList as DetailLink | null | undefined) ?? null;
  const canEdit = atLeast(task.level, 'edit');
  if (!link && !canEdit) return null;

  const refresh = () => {
    refreshTasks(qc);
    void qc.invalidateQueries({ queryKey: ['list'] });
  };
  const unlink = async () => {
    if (!(await confirm({ title: 'Unlink this list?', body: 'The list and its tasks stay as they are; only the link to this task is removed.', confirm: 'Unlink' }))) return;
    try {
      await api.delete(`/list-links/task/${task.id}`);
      toast.ok('List unlinked');
      refresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not unlink');
    }
  };

  return (
    <section className="mt-6">
      <div className="mb-2 flex items-center gap-2">
        <Network className="size-4 text-muted" />
        <h3 className="text-sm font-semibold">Linked list</h3>
        {canEdit && link && (
          <button onClick={() => void unlink()} className="ml-auto inline-flex items-center gap-1 text-xs text-muted hover:text-red-600">
            <Unlink className="size-3.5" />Unlink
          </button>
        )}
      </div>

      {!link && <LinkPicker task={task} onLinked={refresh} />}

      {link?.hidden && (
        <div className="flex items-center gap-2 rounded-lg border border-app bg-subtle px-3 py-2.5 text-sm text-muted">
          <Lock className="size-4 shrink-0" />
          This task is linked to a list you don’t have access to.
        </div>
      )}

      {link && !link.hidden && (
        <div className="rounded-lg border border-app">
          <div className="flex items-center gap-3 border-b border-app px-3 py-2.5">
            <Link to={`/l/${link.listId}`} className="min-w-0 truncate font-medium hover:underline">{link.name}</Link>
            <span className="ml-auto flex shrink-0 items-center gap-3 text-xs text-muted">
              <span className="tabular-nums">{link.done}/{link.total} done</span>
              {link.estimateMin > 0 && <span title="Sum of time estimates">{minutesLabel(link.estimateMin)} est.</span>}
            </span>
          </div>
          <div className="flex items-center gap-2 px-3 pt-2.5">
            <ProgressBar done={link.done} total={link.total} />
            <span className="w-9 text-right text-xs tabular-nums text-muted">{pct(link.done, link.total)}%</span>
          </div>
          {link.preview.length > 0 ? (
            <div className="py-1.5">
              {link.preview.map((t) => (
                <button key={t.id} onClick={() => open(t.key)} className="flex w-full items-center gap-2 px-3 py-1 text-left text-sm hover-bg">
                  <StatusDot status={t.status} />
                  <span className="font-mono text-xs text-muted">{t.key}</span>
                  <span className={cx('min-w-0 flex-1 truncate', t.completedAt && 'text-muted line-through')}>{t.name}</span>
                </button>
              ))}
              {link.total > link.preview.length && (
                <Link to={`/l/${link.listId}`} className="flex items-center gap-1 px-3 py-1 text-xs text-muted hover:text-app">
                  <ExternalLink className="size-3" />Open the list to see all {link.total} tasks
                </Link>
              )}
            </div>
          ) : (
            <div className="px-3 py-2.5 text-sm text-subtle">No tasks in this list yet.</div>
          )}
        </div>
      )}
    </section>
  );
}

function LinkPicker({ task, onLinked }: { task: TaskDetail; onLinked: () => void }) {
  const { prompt } = useDialogs();
  const doLink = async (listId: string) => {
    try {
      await api.put(`/list-links/task/${task.id}`, { listId });
      toast.ok('List linked');
      onLinked();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not link the list');
    }
  };
  const createAndLink = async () => {
    const name = await prompt({ title: 'New linked list', label: 'List name', initial: task.name, confirm: 'Create & link' });
    if (!name || !task.path) return;
    try {
      const [spaceId, folderId] = [task.path.space.id, task.path.folder?.id ?? null];
      const l = await api.post<{ id: string }>('/hierarchy/lists', { spaceId, folderId, name });
      await doLink(l.id);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not create the list');
    }
  };
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-lg border border-dashed border-app px-3 py-2.5 text-sm text-muted">
      <span className="mr-auto">Link a list to track its progress from this task.</span>
      <Popover width={320} align="end" trigger={(p) => <button {...p} className="inline-flex items-center gap-1 rounded-md border border-app bg-app px-2 py-1 text-xs font-medium text-app hover-bg"><Network className="size-3.5" />Link a list</button>}>
        {(close) => <CandidateList taskId={task.id} onPick={(id) => { close(); void doLink(id); }} onCreate={() => { close(); void createAndLink(); }} />}
      </Popover>
    </div>
  );
}

function CandidateList({ taskId, onPick, onCreate }: { taskId: string; onPick: (id: string) => void; onCreate: () => void }) {
  const [q, setQ] = useState('');
  const { data = [], isLoading } = useQuery({
    queryKey: ['list-link-candidates', taskId],
    queryFn: () => api.get<Array<{ id: string; name: string; spaceName: string; folderName: string | null }>>(`/list-links/task/${taskId}/candidates`),
  });
  const shown = data.filter((l) => !q || `${l.spaceName} ${l.folderName ?? ''} ${l.name}`.toLowerCase().includes(q.toLowerCase()));
  return (
    <div>
      <div className="relative mb-1">
        <Search className="pointer-events-none absolute left-2 top-2 size-4 text-subtle" />
        <Input autoFocus className="pl-7" placeholder="Search lists…" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      <div className="max-h-64 overflow-y-auto">
        {isLoading && <div className="px-2 py-3 text-center text-sm text-muted">Loading…</div>}
        {shown.map((l) => (
          <MenuItem key={l.id} onClick={() => onPick(l.id)}>
            <span className="block truncate">{l.name}</span>
            <span className="block truncate text-xs text-subtle">{l.spaceName}{l.folderName ? ` › ${l.folderName}` : ''}</span>
          </MenuItem>
        ))}
        {!isLoading && !shown.length && <div className="px-2 py-3 text-center text-sm text-muted">No lists available to link</div>}
      </div>
      <MenuSeparator />
      <MenuItem icon={<Plus className="size-4" />} onClick={onCreate}>Create a new list and link it</MenuItem>
    </div>
  );
}

/** Banner/breadcrumb at the top of a list that is linked from a task. */
export function ListLinkBanner({ list }: { list: ListDetail }) {
  const open = useOpenTask();
  const owner = (list.linkedFromTask as Owner | undefined) ?? null;
  if (!owner) return null;
  return (
    <div className="flex items-center gap-2 border-b border-app bg-subtle px-5 py-1.5 text-sm text-muted">
      <CornerLeftUp className="size-4 shrink-0" />
      <span className="shrink-0">Linked from task</span>
      <button onClick={() => open(owner.key)} className="inline-flex min-w-0 items-center gap-1.5 text-app hover:underline">
        <span className="font-mono text-xs text-muted">{owner.key}</span>
        <span className={cx('truncate', owner.completedAt && 'line-through')}>{owner.name}</span>
      </button>
      {owner.listName && <span className="hidden truncate text-subtle sm:inline">in {owner.listName}</span>}
    </div>
  );
}

/** Small progress chip on task rows/cards whose task is linked to a list. */
export function LinkProgressChip({ task }: { task: Task }) {
  const r = task.linkedList as Rollup | undefined;
  if (!r) return null;
  if (r.hidden) {
    return <span className="inline-flex shrink-0 items-center gap-0.5 text-xs text-subtle" title="Linked to a list you can't see"><Network className="size-3" /><Lock className="size-2.5" /></span>;
  }
  const done = r.total > 0 && r.done === r.total;
  return (
    <span
      className={cx('inline-flex shrink-0 items-center gap-1 rounded px-1 text-xs tabular-nums', done ? 'text-emerald-600 dark:text-emerald-400' : 'text-subtle')}
      title={`Linked list “${r.name}”: ${r.done} of ${r.total} done${r.estimateMin ? ` · ${minutesLabel(r.estimateMin)} estimated` : ''}`}
    >
      <Network className="size-3" />
      <span className="relative inline-block h-1 w-6 overflow-hidden rounded-full bg-muted">
        <span className="absolute inset-y-0 left-0 rounded-full bg-emerald-500" style={{ width: `${pct(r.done, r.total)}%` }} />
      </span>
      {r.done}/{r.total}
    </span>
  );
}
