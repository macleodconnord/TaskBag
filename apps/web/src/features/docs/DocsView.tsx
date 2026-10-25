import { ChevronDown, ChevronRight, FilePlus, FileText, Plus } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useSearchParams } from 'react-router';
import { Button, cx, Empty, Loading } from '@/components/ui';
import { createDoc, useContainerDocs, type ContainerType, type DocListItem } from './api';
import { DocPane } from './DocPage';

/**
 * The "Doc" view tab on a space, folder or list: that location's pages on the left, the open one
 * on the right (`?view=doc&doc=<id>`, defaulting to the first page).
 */
export function DocsView({ containerType, containerId, canCreate }: { containerType: ContainerType; containerId: string; canCreate: boolean }) {
  const [params, setParams] = useSearchParams();
  const { data: docs = [], isLoading } = useContainerDocs(containerType, containerId);
  const live = useMemo(() => docs.filter((d) => !d.archivedAt), [docs]);
  const roots = useMemo(() => live.filter((d) => !d.parentDocId || !live.some((p) => p.id === d.parentDocId)).sort(byPos), [live]);
  const selected = params.get('doc') ?? roots[0]?.id ?? null;

  const open = (id: string | null) => {
    const p = new URLSearchParams(params);
    p.set('view', 'doc');
    if (id) p.set('doc', id);
    else p.delete('doc');
    setParams(p, { replace: !id });
  };
  const add = async (parentDocId?: string) => {
    const d = await createDoc(parentDocId ? { parentDocId } : { containerType, containerId });
    open(d.id);
  };

  if (isLoading) return <Loading />;
  if (!live.length) {
    return (
      <Empty icon={<FileText className="size-8" />} title="No docs here yet">
        <p className="mb-3">Write meeting notes, specs or runbooks right next to the work they describe.</p>
        {canCreate && <Button variant="primary" onClick={() => void add()}><Plus className="size-4" />Create a doc</Button>}
      </Empty>
    );
  }
  return (
    <div className="flex h-full">
      <aside className="flex w-60 shrink-0 flex-col border-r border-app bg-subtle">
        <div className="flex items-center px-3 pb-1 pt-3">
          <span className="flex-1 text-[11px] font-semibold uppercase tracking-wide text-subtle">Pages</span>
          {canCreate && (
            <button className="rounded p-0.5 text-subtle hover-bg hover:text-app" title="New doc" onClick={() => void add()}>
              <Plus className="size-4" />
            </button>
          )}
        </div>
        <nav className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
          {roots.map((d) => <PageNode key={d.id} doc={d} all={live} depth={0} selected={selected} onOpen={open} onAdd={canCreate ? add : undefined} />)}
        </nav>
      </aside>
      <div className="min-w-0 flex-1">
        {selected && <DocPane key={selected} id={selected} embedded onDeleted={() => open(null)} />}
      </div>
    </div>
  );
}

const byPos = (a: DocListItem, b: DocListItem) => a.position - b.position || a.title.localeCompare(b.title);

function PageNode({ doc, all, depth, selected, onOpen, onAdd }: {
  doc: DocListItem; all: DocListItem[]; depth: number; selected: string | null;
  onOpen: (id: string) => void; onAdd?: (parentDocId: string) => Promise<void>;
}) {
  const children = all.filter((c) => c.parentDocId === doc.id).sort(byPos);
  const [expanded, setExpanded] = useState(true);
  return (
    <div>
      <div className={cx('group flex items-center rounded-md', selected === doc.id ? 'bg-accent-50 text-accent-700 dark:bg-accent-500/15 dark:text-accent-100' : 'hover-bg')}
        style={{ paddingLeft: depth * 14 }}>
        {children.length ? (
          <button className="p-1 text-subtle" onClick={() => setExpanded(!expanded)} aria-label={expanded ? 'Collapse' : 'Expand'}>
            {expanded ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
          </button>
        ) : <span className="w-[22px]" />}
        <button className="flex min-w-0 flex-1 items-center gap-1.5 py-1.5 text-left text-sm" onClick={() => onOpen(doc.id)}>
          <FileText className="size-4 shrink-0 text-subtle" />
          <span className="truncate">{doc.title || 'Untitled'}</span>
        </button>
        {onAdd && (
          <button className="mr-1 rounded p-0.5 text-subtle opacity-0 hover:text-app group-hover:opacity-100" title="Add subpage" onClick={() => void onAdd(doc.id)}>
            <FilePlus className="size-3.5" />
          </button>
        )}
      </div>
      {expanded && children.map((c) => <PageNode key={c.id} doc={c} all={all} depth={depth + 1} selected={selected} onOpen={onOpen} onAdd={onAdd} />)}
    </div>
  );
}
