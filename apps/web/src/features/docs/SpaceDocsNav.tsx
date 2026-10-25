import { Archive, ArrowDown, ArrowUp, ChevronDown, ChevronRight, FilePlus, FileText, MoreHorizontal, Pencil, Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { NavLink, useNavigate } from 'react-router';
import { api } from '@/lib/api';
import { toast } from '@/components/toast';
import { MenuItem, MenuSeparator, Popover, cx, useDialogs } from '@/components/ui';
import { canEdit, createDoc, refreshDocs, useContainerDocs, type DocListItem } from './api';

/** Docs tree under a space/folder in the sidebar, plus a "Doc" item for the "+" menus. */
type Container = { containerType: 'space' | 'folder' | 'list'; containerId: string };

export function SpaceDocsNav({ containerType, containerId }: Container) {
  const { data = [] } = useContainerDocs(containerType, containerId);
  if (!data.length) return null;
  const ids = new Set(data.map((d) => d.id));
  // a child whose parent the user can't see is shown at the top level
  const roots = data.filter((d) => !d.parentDocId || !ids.has(d.parentDocId));
  return (
    <div>
      {roots.map((d, i) => <DocNode key={d.id} doc={d} all={data} siblings={roots} index={i} depth={0} />)}
    </div>
  );
}

function useOpen(id: string) {
  const key = `nav-open:doc:${id}`;
  const [open, setOpen] = useState(() => {
    try { return localStorage.getItem(key) === '1'; } catch { return false; }
  });
  const toggle = () => setOpen((o) => {
    try { localStorage.setItem(key, o ? '0' : '1'); } catch { /* ignore */ }
    return !o;
  });
  return [open, toggle, () => { if (!open) toggle(); }] as const;
}

function DocNode({ doc, all, siblings, index, depth }: { doc: DocListItem; all: DocListItem[]; siblings: DocListItem[]; index: number; depth: number }) {
  const children = all.filter((d) => d.parentDocId === doc.id);
  const [open, toggle, expand] = useOpen(doc.id);
  const nav = useNavigate();
  const { prompt, confirm } = useDialogs();
  const level = doc._perms.level;
  const editable = canEdit(level);

  const addChild = async () => {
    const d = await createDoc({ parentDocId: doc.id });
    expand();
    nav(`/docs/${d.id}`);
  };
  const move = async (delta: number) => {
    await api.post(`/docs/${doc.id}/move`, { parentDocId: doc.parentDocId, index: index + delta });
    void refreshDocs();
  };

  return (
    <div>
      <div className="group/d flex items-center rounded-md hover-bg" style={{ paddingLeft: depth * 12 }}>
        {children.length ? (
          <button className="p-1 text-subtle" onClick={toggle} aria-label={open ? 'Collapse' : 'Expand'}>
            {open ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
          </button>
        ) : <span className="w-[22px]" />}
        <NavLink
          to={`/docs/${doc.id}`}
          className={({ isActive }) => cx('flex min-w-0 flex-1 items-center gap-2 py-1.5 text-sm', isActive ? 'font-medium text-accent-600' : 'text-app')}
        >
          <FileText className="size-4 shrink-0 text-subtle" />
          <span className="truncate">{doc.title || 'Untitled'}</span>
        </NavLink>
        {editable && (
          <div className="flex opacity-0 group-hover/d:opacity-100 focus-within:opacity-100">
            <Popover align="end" width={200} trigger={(p) => <button {...p} className="rounded p-1 text-subtle hover:text-app" title="Doc options"><MoreHorizontal className="size-4" /></button>}>
              {(close) => (
                <>
                  <MenuItem icon={<Pencil className="size-4" />} onClick={async () => {
                    close();
                    const t = await prompt({ title: 'Rename doc', initial: doc.title, confirm: 'Rename' });
                    if (t) { await api.patch(`/docs/${doc.id}`, { title: t }); void refreshDocs(); }
                  }}>Rename</MenuItem>
                  <MenuItem icon={<FilePlus className="size-4" />} onClick={() => { close(); void addChild(); }}>Add subpage</MenuItem>
                  {index > 0 && <MenuItem icon={<ArrowUp className="size-4" />} onClick={() => { close(); void move(-1); }}>Move up</MenuItem>}
                  {index < siblings.length - 1 && <MenuItem icon={<ArrowDown className="size-4" />} onClick={() => { close(); void move(1); }}>Move down</MenuItem>}
                  {level === 'full' && (
                    <>
                      <MenuSeparator />
                      <MenuItem icon={<Archive className="size-4" />} onClick={async () => {
                        close();
                        await api.patch(`/docs/${doc.id}`, { archived: true });
                        void refreshDocs();
                        toast.ok('Doc archived');
                      }}>Archive</MenuItem>
                      <MenuItem danger icon={<Trash2 className="size-4" />} onClick={async () => {
                        close();
                        if (!(await confirm({ title: `Delete “${doc.title}”?`, body: 'The doc, its subpages, comments and history are deleted permanently.', confirm: 'Delete', danger: true }))) return;
                        await api.delete(`/docs/${doc.id}`);
                        void refreshDocs();
                        if (location.pathname.startsWith(`/docs/${doc.id}`)) nav('/');
                      }}>Delete</MenuItem>
                    </>
                  )}
                </>
              )}
            </Popover>
            <button className="rounded p-1 text-subtle hover:text-app" title="Add subpage" onClick={addChild}><Plus className="size-4" /></button>
          </div>
        )}
      </div>
      {open && children.map((c, i) => <DocNode key={c.id} doc={c} all={all} siblings={children} index={i} depth={depth + 1} />)}
    </div>
  );
}

SpaceDocsNav.CreateMenuItem = function CreateDocMenuItem({ containerType, containerId, onDone }: Container & { onDone: () => void }) {
  const nav = useNavigate();
  return (
    <MenuItem
      icon={<FileText className="size-4" />}
      onClick={async () => {
        onDone();
        const d = await createDoc({ containerType, containerId });
        nav(`/docs/${d.id}`);
      }}
    >
      Doc
    </MenuItem>
  );
};
