import type { RichText } from '@app/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Archive, ArchiveRestore, ChevronRight, FilePlus, FileText, History, MoreHorizontal, Paperclip, Share2, Trash2, X,
} from 'lucide-react';
import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import { api, ApiError } from '@/lib/api';
import { fileSize, timeAgo } from '@/lib/format';
import { useUsers } from '@/lib/queries';
import { RichEditor, RichView } from '@/components/editor';
import { StatusDot } from '@/components/pickers';
import { ShareDialog } from '@/components/ShareDialog';
import { fileUrl, uploadFiles } from '@/components/task/Attachments';
import { Comments } from '@/components/task/Comments';
import { useOpenTask } from '@/components/task/TaskDrawer';
import { toast } from '@/components/toast';
import { Avatar, Button, Empty, IconButton, Loading, MenuItem, MenuSeparator, Popover, Spinner, cx, useDialogs } from '@/components/ui';
import {
  canEdit, createDoc, dkeys, findTaskRefs, refreshDocs, useDoc, type DocDetail, type Revision, type TaskRefInfo,
} from './api';

const SAVE_DELAY = 800;
/** True when rendered inside the Doc view tab: doc links stay in the tab (?view=doc&doc=…). */
const EmbeddedCtx = createContext(false);

function useOpenDoc(embedded?: boolean) {
  const nav = useNavigate();
  const [params, setParams] = useSearchParams();
  return (id: string) => {
    if (!embedded) return nav(`/docs/${id}`);
    const p = new URLSearchParams(params);
    p.set('view', 'doc');
    p.set('doc', id);
    setParams(p);
  };
}
const CONTAINER_ROUTE = { space: 's', folder: 'f', list: 'l' } as const;

/** A doc page (D-01): breadcrumb, title + rich editor with autosave, subpages, task refs, files, history, sharing, comments. */
export function DocPage() {
  const { id } = useParams<{ id: string }>();
  return <DocPane id={id} />;
}

/**
 * A doc with its header actions, body and history panel. Used by the /docs/:id page and, `embedded`,
 * by the Doc view tab on a space, folder or list (where the location breadcrumb is redundant).
 */
export function DocPane({ id, embedded, onDeleted }: { id: string | undefined; embedded?: boolean; onDeleted?: () => void }) {
  const { data: doc, isLoading, error } = useDoc(id);
  const [panel, setPanel] = useState<'history' | null>(null);
  const [sharing, setSharing] = useState(false);

  if (isLoading) return <Loading />;
  if (error || !doc) {
    return (
      <Empty icon={<FileText className="size-8" />} title={error instanceof ApiError && error.status === 404 ? 'Doc not found' : 'Could not load this doc'}>
        It may have been deleted, or you don’t have access to it.
      </Empty>
    );
  }
  return (
    <div className="flex h-full flex-col">
      <DocHeader doc={doc} embedded={embedded} onDeleted={onDeleted} onHistory={() => setPanel(panel === 'history' ? null : 'history')} historyOpen={panel === 'history'} onShare={() => setSharing(true)} />
      <div className="flex min-h-0 flex-1">
        <div className="min-w-0 flex-1 overflow-y-auto">
          <EmbeddedCtx.Provider value={!!embedded}>
            <DocBody key={doc.id} doc={doc} />
          </EmbeddedCtx.Provider>
        </div>
        {panel === 'history' && <RevisionsPanel doc={doc} onClose={() => setPanel(null)} />}
      </div>
      {sharing && <ShareDialog type="doc" id={doc.id} name={doc.title} onClose={() => setSharing(false)} />}
    </div>
  );
}

function DocHeader({ doc, embedded, onDeleted, onHistory, historyOpen, onShare }: { doc: DocDetail; embedded?: boolean; onDeleted?: () => void; onHistory: () => void; historyOpen: boolean; onShare: () => void }) {
  const nav = useNavigate();
  const { confirm } = useDialogs();
  const qc = useQueryClient();
  const full = doc.level === 'full';
  const openDoc = useOpenDoc(embedded);
  const setArchived = async (archived: boolean) => {
    await api.patch(`/docs/${doc.id}`, { archived });
    void refreshDocs();
    void qc.invalidateQueries({ queryKey: dkeys.doc(doc.id) });
    toast.ok(archived ? 'Doc archived' : 'Doc restored');
  };
  return (
    <div className={cx('flex items-center gap-2 px-5', embedded ? 'min-h-11' : 'min-h-12 border-b border-app')}>
      <nav className="flex min-w-0 flex-1 items-center gap-1 text-sm text-muted" aria-label="Breadcrumb">
        {!embedded && doc.path.map((p) => (
          <span key={p.id} className="flex min-w-0 items-center gap-1">
            <Link to={`/${CONTAINER_ROUTE[p.type]}/${p.id}`} className="truncate hover:text-app hover:underline">{p.name}</Link>
            <ChevronRight className="size-3.5 shrink-0 text-subtle" />
          </span>
        ))}
        {doc.ancestors.map((a) => (
          <span key={a.id} className="flex min-w-0 items-center gap-1">
            {a.visible ? <Link to={`/docs/${a.id}`} className="truncate hover:text-app hover:underline">{a.title}</Link> : <span>…</span>}
            <ChevronRight className="size-3.5 shrink-0 text-subtle" />
          </span>
        ))}
        {!embedded && (
          <span className="flex min-w-0 items-center gap-1.5 font-medium text-app">
            <FileText className="size-4 shrink-0 text-subtle" />
            <span className="truncate">{doc.title || 'Untitled'}</span>
          </span>
        )}
        {embedded && <Link to={`/docs/${doc.id}`} className="ml-1 text-xs text-subtle hover:text-app hover:underline">Open full page</Link>}
      </nav>
      {full && <Button size="sm" onClick={onShare}><Share2 className="size-3.5" /> Share</Button>}
      <IconButton label="Page history" onClick={onHistory} className={cx(historyOpen && 'bg-muted text-app')}><History className="size-4" /></IconButton>
      {canEdit(doc.level) && (
        <Popover align="end" width={200} trigger={(p) => <IconButton {...p} label="More"><MoreHorizontal className="size-4" /></IconButton>}>
          {(close) => (
            <>
              <MenuItem icon={<FilePlus className="size-4" />} onClick={async () => { close(); const d = await createDoc({ parentDocId: doc.id }); openDoc(d.id); }}>Add subpage</MenuItem>
              {full && (
                <>
                  <MenuSeparator />
                  {doc.archivedAt
                    ? <MenuItem icon={<ArchiveRestore className="size-4" />} onClick={() => { close(); void setArchived(false); }}>Restore from archive</MenuItem>
                    : <MenuItem icon={<Archive className="size-4" />} onClick={() => { close(); void setArchived(true); }}>Archive</MenuItem>}
                  <MenuItem danger icon={<Trash2 className="size-4" />} onClick={async () => {
                    close();
                    if (!(await confirm({ title: `Delete “${doc.title}”?`, body: 'The doc, its subpages, comments and history are deleted permanently.', confirm: 'Delete', danger: true }))) return;
                    await api.delete(`/docs/${doc.id}`);
                    void refreshDocs();
                    if (onDeleted) return onDeleted();
                    nav(doc.parentDocId ? `/docs/${doc.parentDocId}` : `/${CONTAINER_ROUTE[doc.containerType]}/${doc.containerId}`);
                  }}>Delete</MenuItem>
                </>
              )}
            </>
          )}
        </Popover>
      )}
    </div>
  );
}

type SaveState = 'idle' | 'pending' | 'saving' | 'saved' | 'error';

function DocBody({ doc }: { doc: DocDetail }) {
  const qc = useQueryClient();
  const { data: users = [] } = useUsers();
  const editable = canEdit(doc.level) && !doc.archivedAt;
  const [title, setTitle] = useState(doc.title);
  const titleFocused = useRef(false);
  const [state, setState] = useState<SaveState>('idle');
  const pending = useRef<{ title?: string; content?: RichText }>({});
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // follow remote title changes while the user isn't editing it
  useEffect(() => { if (!titleFocused.current && !pending.current.title) setTitle(doc.title); }, [doc.title]);

  const flush = useCallback(async () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    const body = pending.current;
    if (body.title === undefined && body.content === undefined) return;
    pending.current = {};
    setState('saving');
    try {
      const res = await api.patch<{ cannotSee?: string[]; title: string; content: RichText | null; updatedAt: string }>(`/docs/${doc.id}`, body);
      setState('saved');
      qc.setQueryData<DocDetail>(dkeys.doc(doc.id), (d) => (d ? { ...d, title: res.title, content: res.content, updatedAt: res.updatedAt } : d));
      if (body.title !== undefined) void refreshDocs();
      if (res.cannotSee?.length) {
        const names = res.cannotSee.map((u) => users.find((x) => x.id === u)?.displayName ?? 'Someone').join(', ');
        toast.error(`${names} can’t see this doc, so they won’t be notified.`);
      }
    } catch (e) {
      setState('error');
      pending.current = { ...body, ...pending.current };
      toast.error(e instanceof Error ? e.message : 'Could not save');
    }
  }, [doc.id, qc, users]);

  const schedule = (patch: { title?: string; content?: RichText }) => {
    pending.current = { ...pending.current, ...patch };
    setState('pending');
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => void flush(), SAVE_DELAY);
  };

  // save on unmount / navigation and warn before closing with unsaved changes
  useEffect(() => {
    const onUnload = (e: BeforeUnloadEvent) => {
      if (pending.current.title !== undefined || pending.current.content !== undefined) { void flush(); e.preventDefault(); }
    };
    window.addEventListener('beforeunload', onUnload);
    return () => { window.removeEventListener('beforeunload', onUnload); void flush(); };
  }, [flush]);

  return (
    <div className="mx-auto max-w-3xl px-6 pb-16 pt-8">
      {doc.archivedAt && (
        <div className="mb-4 flex items-center gap-2 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200">
          <Archive className="size-4" /> This doc is archived and read-only.
        </div>
      )}
      <textarea
        aria-label="Doc title"
        rows={1}
        value={title}
        readOnly={!editable}
        placeholder="Untitled"
        onFocus={() => { titleFocused.current = true; }}
        onBlur={() => { titleFocused.current = false; void flush(); }}
        onChange={(e) => { const v = e.target.value.replace(/\n/g, ''); setTitle(v); schedule({ title: v.trim() || 'Untitled' }); }}
        onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); (e.currentTarget.parentElement?.querySelector('.ProseMirror') as HTMLElement | null)?.focus(); } }}
        className="w-full resize-none overflow-hidden bg-transparent text-3xl font-bold text-app placeholder-dim focus:outline-none [field-sizing:content]"
      />
      <div className="mb-4 mt-1 flex items-center gap-2 text-xs text-subtle">
        {doc.updater && <><Avatar user={doc.updater} size={16} /> <span>Edited {timeAgo(doc.updatedAt)} by {doc.updater.displayName}</span></>}
        <SaveIndicator state={state} />
      </div>
      {editable ? (
        <RichEditor
          value={doc.content}
          variant="document"
          onChange={(c) => schedule({ content: c })}
          onCommit={() => void flush()}
          uploadImage={async (file) => {
            const [a] = await uploadFiles({ docId: doc.id }, [file]);
            void qc.invalidateQueries({ queryKey: dkeys.doc(doc.id) });
            return fileUrl(a);
          }}
          placeholder="Start writing — type / for headings, tables and images, @ to mention someone"
          minHeight={240}
        />
      ) : (
        doc.content ? <RichView value={doc.content} variant="document" /> : <div className="text-sm text-subtle">This doc is empty.</div>
      )}

      <TaskRefs doc={doc} />
      <Subpages doc={doc} editable={editable} />
      <Files doc={doc} editable={editable} />

      <section className="mt-10">
        <h3 className="mb-3 text-sm font-semibold">Comments</h3>
        <Comments kind="doc" id={doc.id} canComment={doc.level !== 'view' && doc.level !== 'none'} />
      </section>
    </div>
  );
}

function SaveIndicator({ state }: { state: SaveState }) {
  if (state === 'idle') return null;
  return (
    <span className={cx('ml-auto flex items-center gap-1', state === 'error' && 'text-red-600 dark:text-red-400')}>
      {state === 'saving' && <Spinner className="size-3" />}
      {state === 'pending' ? 'Unsaved changes' : state === 'saving' ? 'Saving…' : state === 'saved' ? 'Saved' : 'Not saved — retrying on next edit'}
    </span>
  );
}

/** Tasks referenced in the doc — re-resolved with the viewer's access every time (invisible ones are omitted). */
function TaskRefs({ doc }: { doc: DocDetail }) {
  const openTask = useOpenTask();
  const refs = findTaskRefs(doc.content).join(',');
  const { data = [] } = useQuery({
    queryKey: dkeys.taskRefs(doc.id, refs),
    queryFn: () => api.get<TaskRefInfo[]>(`/docs/${doc.id}/task-refs?ids=${encodeURIComponent(refs)}`),
    enabled: !!refs,
  });
  if (!refs || !data.length) return null;
  return (
    <section className="mt-8">
      <h3 className="mb-2 text-sm font-semibold">Tasks in this doc</h3>
      <div className="divide-y divide-[var(--border)] rounded-lg border border-app">
        {data.map((t) => (
          <button key={t.id} onClick={() => openTask(t.key)} className="flex w-full items-center gap-2.5 px-3 py-2 text-left text-sm hover-bg">
            <StatusDot status={t.status} size={12} />
            <span className="font-mono text-xs text-subtle">{t.key}</span>
            <span className={cx('min-w-0 flex-1 truncate', t.completedAt && 'text-muted line-through')}>{t.name}</span>
            {t.status && <span className="text-xs text-muted">{t.status.name}</span>}
          </button>
        ))}
      </div>
    </section>
  );
}

function Subpages({ doc, editable }: { doc: DocDetail; editable: boolean }) {
  const embedded = useContext(EmbeddedCtx);
  const openDoc = useOpenDoc(embedded);
  if (!doc.children.length && !editable) return null;
  return (
    <section className="mt-8">
      <div className="mb-2 flex items-center">
        <h3 className="flex-1 text-sm font-semibold">Subpages</h3>
        {editable && (
          <Button size="sm" variant="ghost" onClick={async () => { const d = await createDoc({ parentDocId: doc.id }); openDoc(d.id); }}>
            <FilePlus className="size-3.5" /> Add subpage
          </Button>
        )}
      </div>
      {doc.children.length ? (
        <div className="grid gap-2 sm:grid-cols-2">
          {doc.children.map((c) => (
            <Link key={c.id} to={embedded ? `?view=doc&doc=${c.id}` : `/docs/${c.id}`} className="flex items-center gap-2 rounded-lg border border-app px-3 py-2 text-sm hover-bg">
              <FileText className="size-4 shrink-0 text-subtle" />
              <span className="min-w-0 flex-1 truncate">{c.title || 'Untitled'}</span>
              <span className="text-xs text-subtle">{timeAgo(c.updatedAt)}</span>
            </Link>
          ))}
        </div>
      ) : <div className="text-sm text-subtle">No subpages yet.</div>}
    </section>
  );
}

function Files({ doc, editable }: { doc: DocDetail; editable: boolean }) {
  const qc = useQueryClient();
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const inline = JSON.stringify(doc.content ?? '');
  const files = doc.attachments.filter((a) => !inline.includes(`/api/attachments/${a.id}/`));
  if (!files.length && !editable) return null;
  const upload = async (files: FileList) => {
    setBusy(true);
    try {
      await uploadFiles({ docId: doc.id }, files);
      await qc.invalidateQueries({ queryKey: dkeys.doc(doc.id) });
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="mt-8">
      <div className="mb-2 flex items-center">
        <h3 className="flex-1 text-sm font-semibold">Files</h3>
        {editable && <Button size="sm" variant="ghost" loading={busy} onClick={() => input.current?.click()}><Paperclip className="size-3.5" /> Attach</Button>}
        <input ref={input} type="file" multiple hidden onChange={(e) => { if (e.target.files) void upload(e.target.files); e.target.value = ''; }} />
      </div>
      {files.length ? (
        <div className="grid gap-2 sm:grid-cols-2">
          {files.map((a) => (
            <div key={a.id} className="group flex items-center gap-2 rounded-lg border border-app px-3 py-2 text-sm">
              {a.contentType.startsWith('image/')
                ? <img src={fileUrl(a)} alt="" className="size-8 shrink-0 rounded object-cover" />
                : <Paperclip className="size-4 shrink-0 text-subtle" />}
              <a href={fileUrl(a)} target="_blank" rel="noreferrer" className="min-w-0 flex-1 truncate hover:underline">{a.filename}</a>
              <span className="text-xs text-subtle">{fileSize(a.sizeBytes)}</span>
              {editable && (
                <IconButton size="sm" label="Remove file" className="opacity-0 group-hover:opacity-100" onClick={async () => {
                  await api.delete(`/attachments/${a.id}`);
                  void qc.invalidateQueries({ queryKey: dkeys.doc(doc.id) });
                }}><X className="size-3.5" /></IconButton>
              )}
            </div>
          ))}
        </div>
      ) : <div className="text-sm text-subtle">No files yet.</div>}
    </section>
  );
}

function RevisionsPanel({ doc, onClose }: { doc: DocDetail; onClose: () => void }) {
  const qc = useQueryClient();
  const { confirm } = useDialogs();
  const { data: revisions, isLoading } = useQuery({ queryKey: dkeys.revisions(doc.id), queryFn: () => api.get<Revision[]>(`/docs/${doc.id}/revisions`) });
  const [selected, setSelected] = useState<string | null>(null);
  const { data: preview } = useQuery({
    queryKey: ['docs', 'revision', selected],
    queryFn: () => api.get<{ id: string; title: string; content: RichText | null }>(`/docs/${doc.id}/revisions/${selected}`),
    enabled: !!selected,
  });
  const restore = async (r: Revision) => {
    if (!(await confirm({ title: 'Restore this version?', body: `The doc will be replaced with the version from ${new Date(r.createdAt).toLocaleString()}. The current version is kept in the history.`, confirm: 'Restore' }))) return;
    await api.post(`/docs/${doc.id}/revisions/${r.id}/restore`);
    await qc.invalidateQueries({ queryKey: ['docs'] });
    setSelected(null);
    toast.ok('Version restored');
  };
  return (
    <aside className="flex w-80 shrink-0 flex-col border-l border-app bg-subtle">
      <div className="flex h-12 items-center border-b border-app px-3">
        <h2 className="flex-1 text-sm font-semibold">Page history</h2>
        <IconButton size="sm" label="Close history" onClick={onClose}><X className="size-4" /></IconButton>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        <div className="mb-1 rounded-md px-2 py-1.5 text-sm">
          <div className="font-medium">Current version</div>
          <div className="text-xs text-muted">Edited {timeAgo(doc.updatedAt)}{doc.updater ? ` by ${doc.updater.displayName}` : ''}</div>
        </div>
        {isLoading ? <Loading /> : !revisions?.length ? (
          <div className="px-2 py-3 text-sm text-muted">No earlier versions yet. A version is saved at most every 5 minutes while the doc is being edited.</div>
        ) : revisions.map((r) => (
          <div key={r.id} className={cx('rounded-md', selected === r.id && 'bg-muted')}>
            <button className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover-bg" onClick={() => setSelected(selected === r.id ? null : r.id)}>
              {r.author ? <Avatar user={r.author} size={20} /> : <History className="size-4 text-subtle" />}
              <div className="min-w-0 flex-1">
                <div className="truncate" title={new Date(r.createdAt).toLocaleString()}>{new Date(r.createdAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}</div>
                <div className="truncate text-xs text-muted">{r.author?.displayName ?? 'Unknown'} · {r.title}</div>
              </div>
            </button>
            {selected === r.id && (
              <div className="space-y-2 px-2 pb-2">
                <div className="max-h-72 overflow-y-auto rounded-md border border-app bg-app p-2 text-sm">
                  {!preview ? <Spinner /> : (
                    <>
                      <div className="mb-1 font-semibold">{preview.title}</div>
                      {preview.content ? <RichView value={preview.content} /> : <div className="text-subtle">Empty</div>}
                    </>
                  )}
                </div>
                {canEdit(doc.level) && !doc.archivedAt && <Button size="sm" variant="primary" className="w-full" onClick={() => restore(r)}>Restore this version</Button>}
              </div>
            )}
          </div>
        ))}
      </div>
    </aside>
  );
}
