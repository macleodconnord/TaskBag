import { DndContext, PointerSensor, closestCenter, useSensor, useSensors, type DragEndEvent } from '@dnd-kit/core';
import { SortableContext, arrayMove, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { useQueryClient } from '@tanstack/react-query';
import {
  Archive, ChevronDown, ChevronRight, CircleDot, Folder, FolderPlus, Home, Inbox, Layers, List, ListPlus, LogOut, Moon,
  MoreHorizontal, Pencil, Plus, Search, Settings, Share2, Shield, Sun, SunMoon, Trash2, Users, Plug, Webhook, Download, Lock,
} from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { NavLink, useNavigate } from 'react-router';
import { api } from '@/lib/api';
import { keys, queryClient, useTree } from '@/lib/queries';
import { setTheme } from '@/lib/theme';
import type { Me, TreeFolder, TreeList, TreeSpace } from '@/lib/types';
import { InboxBadge } from '@/features/notifications/InboxBadge';
import { SpaceDocsNav } from '@/features/docs/SpaceDocsNav';
import { TemplateListMenuItem } from '@/features/templates/TemplateListMenuItem';
import { ShareDialog } from '../ShareDialog';
import { StatusEditor } from '../StatusEditor';
import { CreateSpaceDialog } from '../CreateSpaceDialog';
import { MoveListDialog } from '../MoveListDialog';
import { Avatar, cx, MenuItem, MenuSeparator, Popover, textOn, useDialogs } from '../ui';
import { toast } from '../toast';

type Dialog =
  | { kind: 'share'; type: 'space' | 'folder' | 'list'; id: string; name: string }
  | { kind: 'statuses'; type: 'space' | 'list'; id: string; name: string }
  | { kind: 'move-list'; list: TreeList }
  | null;

export function Sidebar({ me }: { me: Me }) {
  const { data: tree } = useTree();
  const [dialog, setDialog] = useState<Dialog>(null);
  const [createSpace, setCreateSpace] = useState(false);
  const isAdmin = me.role === 'owner' || me.role === 'admin';

  return (
    <aside className="flex w-64 shrink-0 flex-col border-r border-app bg-subtle">
      <UserMenu me={me} />
      <nav className="space-y-0.5 px-2 py-1">
        <NavItem to="/" icon={<Home className="size-4" />} end>My Work</NavItem>
        <NavItem to="/inbox" icon={<Inbox className="size-4" />} right={<InboxBadge />}>Inbox</NavItem>
        <NavItem to="/search" icon={<Search className="size-4" />}>Search</NavItem>
        {me.role !== 'guest' && <NavItem to="/everything" icon={<Layers className="size-4" />}>Everything</NavItem>}
      </nav>

      <div className="mt-3 flex items-center justify-between px-4 pb-1">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-subtle">Spaces</span>
        {tree?.canCreateSpace && (
          <button className="rounded p-0.5 text-subtle hover-bg hover:text-app" title="New space" onClick={() => setCreateSpace(true)}>
            <Plus className="size-4" />
          </button>
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-4">
        {tree && <SpaceList spaces={tree.spaces} onDialog={setDialog} />}
        {tree && !tree.spaces.length && <div className="px-2 py-4 text-sm text-muted">No spaces yet.</div>}
      </div>

      {isAdmin && (
        <div className="border-t border-app px-2 py-2">
          <Popover
            align="start"
            width={220}
            trigger={(p) => (
              <button {...p} className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm text-muted hover-bg hover:text-app">
                <Shield className="size-4" /> Admin
              </button>
            )}
          >
            {(close) => (
              <AdminMenu close={close} />
            )}
          </Popover>
        </div>
      )}

      {dialog?.kind === 'share' && <ShareDialog type={dialog.type} id={dialog.id} name={dialog.name} onClose={() => setDialog(null)} />}
      {dialog?.kind === 'statuses' && <StatusEditor type={dialog.type} id={dialog.id} name={dialog.name} onClose={() => setDialog(null)} />}
      {dialog?.kind === 'move-list' && <MoveListDialog list={dialog.list} onClose={() => setDialog(null)} />}
      <CreateSpaceDialog open={createSpace} onClose={() => setCreateSpace(false)} />
    </aside>
  );
}

function AdminMenu({ close }: { close: () => void }) {
  const nav = useNavigate();
  const go = (to: string) => { nav(to); close(); };
  return (
    <>
      <MenuItem icon={<Users className="size-4" />} onClick={() => go('/admin/users')}>Users</MenuItem>
      <MenuItem icon={<Users className="size-4" />} onClick={() => go('/admin/groups')}>Groups</MenuItem>
      <MenuItem icon={<Plug className="size-4" />} onClick={() => go('/admin/integrations')}>Integrations & credentials</MenuItem>
      <MenuItem icon={<Webhook className="size-4" />} onClick={() => go('/admin/webhooks')}>Outbound webhooks</MenuItem>
      <MenuItem icon={<Download className="size-4" />} onClick={() => go('/admin/import')}>ClickUp import</MenuItem>
    </>
  );
}

function UserMenu({ me }: { me: Me }) {
  const nav = useNavigate();
  const saveTheme = async (theme: Me['theme']) => {
    setTheme(theme);
    await api.patch('/users/me', { theme });
    void queryClient.invalidateQueries({ queryKey: keys.me });
  };
  return (
    <div className="flex h-12 items-center px-2">
      <Popover
        width={230}
        trigger={(p) => (
          <button {...p} className="flex min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-1.5 hover-bg">
            <img src="/favicon.svg" alt="" className="size-5" />
            <span className="flex-1 truncate text-left text-sm font-semibold">Projects</span>
            <Avatar user={me} size={22} />
          </button>
        )}
      >
        {(close) => (
          <>
            <div className="px-2 py-1.5">
              <div className="text-sm font-medium">{me.displayName}</div>
              <div className="truncate text-xs text-muted">{me.email}</div>
            </div>
            <MenuSeparator />
            <MenuItem icon={<Settings className="size-4" />} onClick={() => { nav('/settings'); close(); }}>Settings</MenuItem>
            <MenuItem icon={<Sun className="size-4" />} active={me.theme === 'light'} onClick={() => void saveTheme('light')}>Light theme</MenuItem>
            <MenuItem icon={<Moon className="size-4" />} active={me.theme === 'dark'} onClick={() => void saveTheme('dark')}>Dark theme</MenuItem>
            <MenuItem icon={<SunMoon className="size-4" />} active={me.theme === 'system'} onClick={() => void saveTheme('system')}>Match system</MenuItem>
            <MenuSeparator />
            <MenuItem icon={<LogOut className="size-4" />} onClick={async () => { await api.post('/auth/logout'); queryClient.clear(); location.href = '/login'; }}>Sign out</MenuItem>
          </>
        )}
      </Popover>
    </div>
  );
}

function NavItem({ to, icon, children, end, right }: { to: string; icon: ReactNode; children: ReactNode; end?: boolean; right?: ReactNode }) {
  return (
    <NavLink
      to={to}
      end={end}
      className={({ isActive }) => cx('flex items-center gap-2 rounded-md px-2 py-1.5 text-sm', isActive ? 'bg-accent-50 font-medium text-accent-700 dark:bg-accent-500/15 dark:text-accent-100' : 'text-app hover-bg')}
    >
      {icon}
      <span className="flex-1 truncate">{children}</span>
      {right}
    </NavLink>
  );
}

// ───────────── spaces / folders / lists ─────────────

function useOpenState(key: string, initial = true) {
  const storageKey = `nav-open:${key}`;
  const [open, setOpen] = useState(() => {
    try {
      const v = localStorage.getItem(storageKey);
      return v === null ? initial : v === '1';
    } catch {
      return initial;
    }
  });
  const toggle = () => {
    setOpen((o) => {
      try { localStorage.setItem(storageKey, o ? '0' : '1'); } catch { /* ignore */ }
      return !o;
    });
  };
  return [open, toggle] as const;
}

function SpaceList({ spaces, onDialog }: { spaces: TreeSpace[]; onDialog: (d: Dialog) => void }) {
  const qc = useQueryClient();
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));
  const onDragEnd = async (e: DragEndEvent) => {
    if (!e.over || e.active.id === e.over.id) return;
    const from = spaces.findIndex((s) => s.id === e.active.id);
    const to = spaces.findIndex((s) => s.id === e.over!.id);
    const next = arrayMove(spaces, from, to);
    qc.setQueryData(keys.tree, (t: { spaces: TreeSpace[] } | undefined) => (t ? { ...t, spaces: next } : t));
    await Promise.all(next.map((s, i) => (s.position !== i && s._perms.level !== 'none' ? api.patch(`/hierarchy/spaces/${s.id}`, { position: i }).catch(() => null) : null)));
    void qc.invalidateQueries({ queryKey: keys.tree });
  };
  return (
    <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
      <SortableContext items={spaces.map((s) => s.id)} strategy={verticalListSortingStrategy}>
        {spaces.map((s) => <SpaceNode key={s.id} space={s} onDialog={onDialog} />)}
      </SortableContext>
    </DndContext>
  );
}

type DragHandle = Record<string, unknown>;
/** Sortable wrapper. With a render-prop child only the element given `handle` starts a drag (nested sortables). */
function Sortable({ id, children }: { id: string; children: ReactNode | ((handle: DragHandle) => ReactNode) }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id });
  const handle = { ...attributes, ...listeners };
  const style = { transform: CSS.Transform.toString(transform), transition, opacity: isDragging ? 0.5 : 1 };
  if (typeof children === 'function') return <div ref={setNodeRef} style={style}>{children(handle)}</div>;
  return <div ref={setNodeRef} style={style} {...handle}>{children}</div>;
}

function SpaceNode({ space, onDialog }: { space: TreeSpace; onDialog: (d: Dialog) => void }) {
  const [open, toggle] = useOpenState(`space:${space.id}`);
  const nav = useNavigate();
  const { prompt, confirm } = useDialogs();
  const level = space._perms.level;
  const canEdit = level === 'edit' || level === 'full';
  const isFull = level === 'full';
  const refresh = () => queryClient.invalidateQueries({ queryKey: keys.tree });

  const addList = async (folderId?: string) => {
    const name = await prompt({ title: 'New list', label: 'Name', confirm: 'Create' });
    if (!name) return;
    const l = await api.post<{ id: string }>('/hierarchy/lists', { spaceId: space.id, folderId: folderId ?? null, name });
    await refresh();
    nav(`/l/${l.id}`);
  };

  return (
    <Sortable id={space.id}>
      {(handle) => (
      <div className="group mt-0.5">
        <div className="flex items-center rounded-md hover-bg" {...handle}>
          <button className="p-1 text-subtle" onClick={toggle} aria-label={open ? 'Collapse' : 'Expand'}>
            {open ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
          </button>
          <NavLink
            to={space.navOnly ? '#' : `/s/${space.id}`}
            onClick={(e) => space.navOnly && e.preventDefault()}
            className={({ isActive }) => cx('flex min-w-0 flex-1 items-center gap-2 py-1.5 pr-1 text-sm font-medium', isActive && !space.navOnly && 'text-accent-600')}
          >
            <span className="flex size-5 shrink-0 items-center justify-center rounded text-[10px] font-bold" style={{ backgroundColor: space.color ?? '#6366f1', color: textOn(space.color ?? '#6366f1') }}>
              {space.name[0]?.toUpperCase()}
            </span>
            <span className="truncate">{space.name}</span>
          </NavLink>
          {!space.navOnly && (
            <div className="flex opacity-0 group-hover:opacity-100 focus-within:opacity-100">
              <Popover align="end" width={220} trigger={(p) => <button {...p} className="rounded p-1 text-subtle hover:text-app" title="Space options"><MoreHorizontal className="size-4" /></button>}>
                {(close) => (
                  <>
                    {canEdit && <MenuItem icon={<Pencil className="size-4" />} onClick={async () => { close(); const n = await prompt({ title: 'Rename space', initial: space.name, confirm: 'Rename' }); if (n) { await api.patch(`/hierarchy/spaces/${space.id}`, { name: n }); void refresh(); } }}>Rename</MenuItem>}
                    {isFull && <MenuItem icon={<Share2 className="size-4" />} onClick={() => { close(); onDialog({ kind: 'share', type: 'space', id: space.id, name: space.name }); }}>Sharing & permissions</MenuItem>}
                    {isFull && <MenuItem icon={<CircleDot className="size-4" />} onClick={() => { close(); onDialog({ kind: 'statuses', type: 'space', id: space.id, name: space.name }); }}>Statuses</MenuItem>}
                    {isFull && <MenuSeparator />}
                    {isFull && <MenuItem icon={<Archive className="size-4" />} onClick={async () => { close(); await api.patch(`/hierarchy/spaces/${space.id}`, { archived: true }); void refresh(); toast.ok('Space archived'); }}>Archive</MenuItem>}
                    {isFull && <MenuItem danger icon={<Trash2 className="size-4" />} onClick={async () => { close(); if (await confirm({ title: `Delete “${space.name}”?`, body: 'This permanently deletes the space with all its folders, lists, tasks and docs.', confirm: 'Delete', danger: true })) { await api.delete(`/hierarchy/spaces/${space.id}`); void refresh(); nav('/'); } }}>Delete</MenuItem>}
                  </>
                )}
              </Popover>
              {canEdit && (
                <Popover align="end" width={200} trigger={(p) => <button {...p} className="rounded p-1 text-subtle hover:text-app" title="Add to space"><Plus className="size-4" /></button>}>
                  {(close) => (
                    <>
                      <MenuItem icon={<ListPlus className="size-4" />} onClick={() => { close(); void addList(); }}>List</MenuItem>
                      <TemplateListMenuItem spaceId={space.id} folderId={null} onDone={close} />
                      <MenuItem icon={<FolderPlus className="size-4" />} onClick={async () => { close(); const n = await prompt({ title: 'New folder', label: 'Name', confirm: 'Create' }); if (n) { await api.post('/hierarchy/folders', { spaceId: space.id, name: n }); void refresh(); } }}>Folder</MenuItem>
                      <SpaceDocsNav.CreateMenuItem containerType="space" containerId={space.id} onDone={close} />
                    </>
                  )}
                </Popover>
              )}
            </div>
          )}
        </div>
        {open && (
          <div className="ml-3 border-l border-app pl-1">
            {space.folders.map((f) => <FolderNode key={f.id} folder={f} onDialog={onDialog} onAddList={() => addList(f.id)} />)}
            <ListNodes lists={space.lists} onDialog={onDialog} />
            {!space.navOnly && <SpaceDocsNav containerType="space" containerId={space.id} />}
          </div>
        )}
      </div>
      )}
    </Sortable>
  );
}

function FolderNode({ folder, onDialog, onAddList }: { folder: TreeFolder; onDialog: (d: Dialog) => void; onAddList: () => void }) {
  const [open, toggle] = useOpenState(`folder:${folder.id}`);
  const { prompt, confirm } = useDialogs();
  const nav = useNavigate();
  const level = folder._perms.level;
  const canEdit = level === 'edit' || level === 'full';
  const refresh = () => queryClient.invalidateQueries({ queryKey: keys.tree });
  return (
    <div className="group/f">
      <div className="flex items-center rounded-md hover-bg">
        <button className="p-1 text-subtle" onClick={toggle} aria-label={open ? 'Collapse' : 'Expand'}>
          {open ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
        </button>
        <NavLink to={folder.navOnly ? '#' : `/f/${folder.id}`} onClick={(e) => folder.navOnly && e.preventDefault()}
          className={({ isActive }) => cx('flex min-w-0 flex-1 items-center gap-2 py-1.5 text-sm', isActive && !folder.navOnly && 'text-accent-600')}>
          <Folder className="size-4 shrink-0 text-subtle" />
          <span className="truncate">{folder.name}</span>
        </NavLink>
        {!folder.navOnly && canEdit && (
          <div className="flex opacity-0 group-hover/f:opacity-100">
            <Popover align="end" width={220} trigger={(p) => <button {...p} className="rounded p-1 text-subtle hover:text-app" title="Folder options"><MoreHorizontal className="size-4" /></button>}>
              {(close) => (
                <>
                  <MenuItem icon={<ListPlus className="size-4" />} onClick={() => { close(); onAddList(); }}>New list</MenuItem>
                  <TemplateListMenuItem spaceId={folder.spaceId} folderId={folder.id} onDone={close} />
                  <SpaceDocsNav.CreateMenuItem containerType="folder" containerId={folder.id} onDone={close} />
                  <MenuItem icon={<Pencil className="size-4" />} onClick={async () => { close(); const n = await prompt({ title: 'Rename folder', initial: folder.name, confirm: 'Rename' }); if (n) { await api.patch(`/hierarchy/folders/${folder.id}`, { name: n }); void refresh(); } }}>Rename</MenuItem>
                  {level === 'full' && (
                    <>
                      <MenuItem icon={<Share2 className="size-4" />} onClick={() => { close(); onDialog({ kind: 'share', type: 'folder', id: folder.id, name: folder.name }); }}>Sharing & permissions</MenuItem>
                      <MenuSeparator />
                      <MenuItem icon={<Archive className="size-4" />} onClick={async () => { close(); await api.patch(`/hierarchy/folders/${folder.id}`, { archived: true }); void refresh(); }}>Archive</MenuItem>
                      <MenuItem danger icon={<Trash2 className="size-4" />} onClick={async () => { close(); if (await confirm({ title: `Delete folder “${folder.name}”?`, body: 'All lists, tasks and docs in it are deleted permanently.', confirm: 'Delete', danger: true })) { await api.delete(`/hierarchy/folders/${folder.id}`); void refresh(); nav('/'); } }}>Delete</MenuItem>
                    </>
                  )}
                </>
              )}
            </Popover>
          </div>
        )}
      </div>
      {open && (
        <div className="ml-3 pl-1">
          <ListNodes lists={folder.lists} onDialog={onDialog} />
          {!folder.navOnly && <SpaceDocsNav containerType="folder" containerId={folder.id} />}
        </div>
      )}
    </div>
  );
}

function ListNodes({ lists, onDialog }: { lists: TreeList[]; onDialog: (d: Dialog) => void }) {
  const qc = useQueryClient();
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));
  const onDragEnd = async (e: DragEndEvent) => {
    if (!e.over || e.active.id === e.over.id) return;
    const next = arrayMove(lists, lists.findIndex((l) => l.id === e.active.id), lists.findIndex((l) => l.id === e.over!.id));
    await Promise.all(next.map((l, i) => (l.position !== i && !l.navOnly ? api.patch(`/hierarchy/lists/${l.id}`, { position: i }).catch(() => null) : null)));
    void qc.invalidateQueries({ queryKey: keys.tree });
  };
  return (
    <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
      <SortableContext items={lists.map((l) => l.id)} strategy={verticalListSortingStrategy}>
        {lists.map((l) => <Sortable key={l.id} id={l.id}><ListNode list={l} onDialog={onDialog} /></Sortable>)}
      </SortableContext>
    </DndContext>
  );
}

function ListNode({ list, onDialog }: { list: TreeList; onDialog: (d: Dialog) => void }) {
  const { prompt, confirm } = useDialogs();
  const nav = useNavigate();
  const level = list._perms.level;
  const refresh = () => queryClient.invalidateQueries({ queryKey: keys.tree });
  return (
    <div className="group/l flex items-center rounded-md hover-bg">
      <NavLink to={`/l/${list.id}`}
        className={({ isActive }) => cx('flex min-w-0 flex-1 items-center gap-2 py-1.5 pl-2 text-sm', isActive ? 'font-medium text-accent-600' : 'text-app')}>
        <List className="size-4 shrink-0 text-subtle" />
        <span className="truncate">{list.name}</span>
        {list.navOnly && <Lock className="size-3 text-subtle" />}
      </NavLink>
      {(level === 'edit' || level === 'full') && (
        <div className="opacity-0 group-hover/l:opacity-100">
          <Popover align="end" width={220} trigger={(p) => <button {...p} className="rounded p-1 text-subtle hover:text-app" title="List options"><MoreHorizontal className="size-4" /></button>}>
            {(close) => (
              <>
                <MenuItem icon={<Pencil className="size-4" />} onClick={async () => { close(); const n = await prompt({ title: 'Rename list', initial: list.name, confirm: 'Rename' }); if (n) { await api.patch(`/hierarchy/lists/${list.id}`, { name: n }); void refresh(); } }}>Rename</MenuItem>
                <MenuItem icon={<Folder className="size-4" />} onClick={() => { close(); onDialog({ kind: 'move-list', list }); }}>Move…</MenuItem>
                {level === 'full' && (
                  <>
                    <MenuItem icon={<Share2 className="size-4" />} onClick={() => { close(); onDialog({ kind: 'share', type: 'list', id: list.id, name: list.name }); }}>Sharing & permissions</MenuItem>
                    <MenuItem icon={<CircleDot className="size-4" />} onClick={() => { close(); onDialog({ kind: 'statuses', type: 'list', id: list.id, name: list.name }); }}>Statuses</MenuItem>
                    <MenuSeparator />
                    <MenuItem icon={<Archive className="size-4" />} onClick={async () => { close(); await api.patch(`/hierarchy/lists/${list.id}`, { archived: true }); void refresh(); }}>Archive</MenuItem>
                    <MenuItem danger icon={<Trash2 className="size-4" />} onClick={async () => { close(); if (await confirm({ title: `Delete list “${list.name}”?`, body: 'All tasks in it are deleted permanently.', confirm: 'Delete', danger: true })) { await api.delete(`/hierarchy/lists/${list.id}`); void refresh(); nav('/'); } }}>Delete</MenuItem>
                  </>
                )}
              </>
            )}
          </Popover>
        </div>
      )}
    </div>
  );
}
