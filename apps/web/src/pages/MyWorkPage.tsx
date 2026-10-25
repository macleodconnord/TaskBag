import { ChevronDown, ChevronRight, Home } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { dayDiff } from '@/lib/format';
import { POLL_FAST, useMe, useTree, useUpdateTask } from '@/lib/queries';
import type { Task } from '@/lib/types';
import { DueDate, PriorityFlag, StatusDot } from '@/components/pickers';
import { useOpenTask } from '@/components/task/TaskDrawer';
import { Empty, Loading, PageHeader, cx } from '@/components/ui';

const BUCKETS = [
  { key: 'overdue', label: 'Overdue', test: (d: number | null) => d !== null && d < 0 },
  { key: 'today', label: 'Today', test: (d: number | null) => d === 0 },
  { key: 'next', label: 'Next', test: (d: number | null) => d !== null && d > 0 },
  { key: 'none', label: 'Unscheduled', test: (d: number | null) => d === null },
] as const;

/** Home: everything assigned to me, bucketed Overdue / Today / Next / Unscheduled. */
export function MyWorkPage() {
  const { data: me } = useMe();
  const { data: tree } = useTree();
  const { data: tasks, isLoading } = useQuery({ queryKey: ['tasks', 'my-work'], queryFn: () => api.get<Task[]>('/tasks/my-work'), refetchInterval: POLL_FAST });
  const listNames = useMemo(() => {
    const m = new Map<string, string>();
    for (const s of tree?.spaces ?? []) for (const l of [...s.lists, ...s.folders.flatMap((f) => f.lists)]) m.set(l.id, `${s.name} › ${l.name}`);
    return m;
  }, [tree]);
  const greeting = new Date().getHours() < 12 ? 'Good morning' : new Date().getHours() < 18 ? 'Good afternoon' : 'Good evening';

  return (
    <div className="flex h-full flex-col">
      <PageHeader title="My Work" icon={<Home className="size-5 text-muted" />} />
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-4xl px-6 py-6">
          <h2 className="mb-5 text-2xl font-semibold">{greeting}{me ? `, ${me.user.displayName.split(' ')[0]}` : ''}</h2>
          {isLoading ? <Loading /> : !tasks?.length ? (
            <Empty title="Nothing assigned to you">Tasks assigned to you across every space show up here.</Empty>
          ) : (
            BUCKETS.map((b) => {
              const items = tasks.filter((t) => b.test(t.dueAt ? dayDiff(t.dueAt) : null));
              return items.length ? <Bucket key={b.key} label={b.label} tasks={items} listNames={listNames} danger={b.key === 'overdue'} /> : null;
            })
          )}
        </div>
      </div>
    </div>
  );
}

function Bucket({ label, tasks, listNames, danger }: { label: string; tasks: Task[]; listNames: Map<string, string>; danger?: boolean }) {
  const [open, setOpen] = useState(true);
  const openTask = useOpenTask();
  const update = useUpdateTask();
  return (
    <section className="mb-6">
      <button className="mb-2 flex items-center gap-1.5 text-sm font-semibold" onClick={() => setOpen(!open)}>
        {open ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}
        <span className={cx(danger && 'text-red-600 dark:text-red-400')}>{label}</span>
        <span className="font-normal text-muted">{tasks.length}</span>
      </button>
      {open && (
        <div className="divide-y divide-[var(--border)] rounded-lg border border-app">
          {tasks.map((t) => (
            <div key={t.id} className="group flex items-center gap-3 px-3 py-2 text-sm hover-bg">
              <button
                title={`Mark ${t.status?.group === 'done' ? 'not done' : 'done'}`}
                onClick={async () => {
                  // quick-complete: needs the list's statuses
                  const detail = await api.get<{ statuses: Array<{ id: string; group: string }> }>(`/tasks/${t.id}`);
                  const target = detail.statuses.find((s) => s.group === 'done') ?? detail.statuses.find((s) => s.group === 'closed');
                  if (target) update.mutate({ id: t.id, statusId: target.id });
                }}
              >
                <StatusDot status={t.status} size={14} />
              </button>
              <button onClick={() => openTask(t.key)} className="min-w-0 flex-1 truncate text-left hover:underline">{t.name}</button>
              <span className="hidden max-w-48 truncate text-xs text-subtle sm:inline">{listNames.get(t.listId)}</span>
              {t.priority && <PriorityFlag value={t.priority} />}
              <span className="w-24 text-right"><DueDate iso={t.dueAt} /></span>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
