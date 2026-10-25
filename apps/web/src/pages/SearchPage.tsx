import { useQuery } from '@tanstack/react-query';
import { FileText, MessageSquare, Search, SquareCheck } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { api, qs } from '@/lib/api';
import { useOpenTask } from '@/components/task/TaskDrawer';
import { Empty, Input, Loading, PageHeader } from '@/components/ui';

type Results = {
  tasks: Array<{ id: string; key: string; name: string; completedAt: string | null }>;
  comments: Array<{ id: string; taskId: string; snippet: string; taskKey: string; taskName: string }>;
  docs: Array<{ id: string; title: string; snippet: string }>;
};

/** Renders ts_headline snippets, whose matches are wrapped in « » by the server. */
function Snippet({ text }: { text: string }) {
  const parts = text.split(/(«[^»]*»)/g);
  return <>{parts.map((p, i) => (p.startsWith('«') ? <mark key={i} className="rounded bg-yellow-200 px-0.5 dark:bg-yellow-700/50 dark:text-yellow-100">{p.slice(1, -1)}</mark> : p))}</>;
}

export function SearchPage() {
  const [params, setParams] = useSearchParams();
  const [q, setQ] = useState(params.get('q') ?? '');
  const [debounced, setDebounced] = useState(q);
  const open = useOpenTask();
  useEffect(() => {
    const t = setTimeout(() => {
      setDebounced(q);
      const p = new URLSearchParams(params);
      if (q) p.set('q', q); else p.delete('q');
      setParams(p, { replace: true });
    }, 250);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q]);
  const { data, isFetching } = useQuery({ queryKey: ['search', debounced], queryFn: () => api.get<Results>(`/search${qs({ q: debounced })}`), enabled: debounced.trim().length > 0 });
  const empty = data && !data.tasks.length && !data.comments.length && !data.docs.length;

  return (
    <div className="flex h-full flex-col">
      <PageHeader title="Search" icon={<Search className="size-5 text-muted" />} />
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-3xl px-6 py-6">
          <Input autoFocus className="h-10 text-base" placeholder="Search tasks, comments and docs…" value={q} onChange={(e) => setQ(e.target.value)} />
          {isFetching && !data && <Loading />}
          {empty && <Empty title="No results">Try fewer or different words. Task keys like OPS-12 work too.</Empty>}
          {data && data.tasks.length > 0 && (
            <ResultGroup title="Tasks" icon={<SquareCheck className="size-4" />}>
              {data.tasks.map((t) => (
                <button key={t.id} onClick={() => open(t.key)} className="flex w-full items-center gap-3 px-3 py-2 text-left text-sm hover-bg">
                  <span className="w-20 shrink-0 font-mono text-xs text-muted">{t.key}</span>
                  <span className={t.completedAt ? 'text-muted line-through' : ''}>{t.name}</span>
                </button>
              ))}
            </ResultGroup>
          )}
          {data && data.comments.length > 0 && (
            <ResultGroup title="Comments" icon={<MessageSquare className="size-4" />}>
              {data.comments.map((c) => (
                <button key={c.id} onClick={() => open(c.taskKey)} className="block w-full px-3 py-2 text-left text-sm hover-bg">
                  <div className="text-xs text-muted">{c.taskKey} · {c.taskName}</div>
                  <div className="mt-0.5"><Snippet text={c.snippet} /></div>
                </button>
              ))}
            </ResultGroup>
          )}
          {data && data.docs.length > 0 && (
            <ResultGroup title="Docs" icon={<FileText className="size-4" />}>
              {data.docs.map((d) => (
                <Link key={d.id} to={`/docs/${d.id}`} className="block px-3 py-2 text-sm hover-bg">
                  <div className="font-medium">{d.title}</div>
                  {d.snippet && <div className="mt-0.5 text-muted"><Snippet text={d.snippet} /></div>}
                </Link>
              ))}
            </ResultGroup>
          )}
        </div>
      </div>
    </div>
  );
}

function ResultGroup({ title, icon, children }: { title: string; icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="mt-6">
      <h2 className="mb-2 flex items-center gap-1.5 text-sm font-semibold text-muted">{icon}{title}</h2>
      <div className="divide-y divide-[var(--border)] rounded-lg border border-app">{children}</div>
    </section>
  );
}
