import { VIEW_TYPES, type FilterGroup, type ViewConfig, type ViewType } from '@app/shared';
import { useQuery } from '@tanstack/react-query';
import { CircleDot, FileText, Layers, List as ListIcon, MoreHorizontal, RotateCcw, Save, Search, Share2, User as UserIcon } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useParams, useSearchParams } from 'react-router';
import { api } from '@/lib/api';
import { useList, useMe, useTags, useTasks, useTree, useUsers } from '@/lib/queries';
import type { Status, Task } from '@/lib/types';
import { FieldValueCell, ManageFieldsMenuItem, useFieldsForScope } from '@/features/fields/public';
import { DocsView } from '@/features/docs/DocsView';
import { ListLinkBanner } from '@/features/list-links/ListLinks';
import { SaveListAsTemplateMenuItem } from '@/features/templates/TemplateListMenuItem';
import { ListIntegrationMenuItems } from '@/features/integrations/ListIntegrationSettings';
import { defaultConfig, useSavedViews, useViewMutations, type SavedView, type ScopeRef } from '@/features/views/api';
import { CalendarView } from '@/features/views/CalendarView';
import { groupOptions, initialConfig } from '@/features/views/config';
import { cleanFilter, FilterButton, type FilterSources, type StatusOption } from '@/features/views/FilterBuilder';
import { GanttView } from '@/features/views/GanttView';
import { TableView } from '@/features/views/TableView';
import { ColumnsButton, OptionsButton, SortButton } from '@/features/views/ViewControls';
import { NewViewButton, ViewTabs } from '@/features/views/ViewTabs';
import { BoardView } from '@/components/views/BoardView';
import { ListView } from '@/components/views/ListView';
import { groupTasks } from '@/components/views/grouping';
import { ShareDialog } from '@/components/ShareDialog';
import { StatusEditor } from '@/components/StatusEditor';
import { toast } from '@/components/toast';
import { Button, cx, Empty, IconButton, Input, Loading, MenuItem, PageHeader, Popover } from '@/components/ui';

type Scope = 'space' | 'folder' | 'list' | 'everything';

const builtinKey = (scope: ScopeRef, type: ViewType) => `views:builtin:${scope.type}:${scope.id ?? ''}:${type}`;
function loadBuiltin(scope: ScopeRef, type: ViewType): ViewConfig | null {
  try {
    const s = localStorage.getItem(builtinKey(scope, type));
    return s ? { ...initialConfig(type, defaultConfig()), ...JSON.parse(s) } : null;
  } catch { return null; }
}
function saveBuiltin(scope: ScopeRef, type: ViewType, c: ViewConfig | null) {
  try {
    if (c) localStorage.setItem(builtinKey(scope, type), JSON.stringify(c));
    else localStorage.removeItem(builtinKey(scope, type));
  } catch { /* storage unavailable */ }
}
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** A space, folder, list or "Everything": tasks shown through built-in or saved views (List, Board, Table, Calendar, Gantt). */
export function ScopePage({ scope }: { scope: Scope }) {
  const { id } = useParams();
  const [params, setParams] = useSearchParams();
  const scopeRef: ScopeRef = useMemo(() => ({ type: scope, id: scope === 'everything' ? undefined : id }), [scope, id]);
  const [mine, setMine] = useState(false);
  const [q, setQ] = useState('');
  const [dialog, setDialog] = useState<'share' | 'statuses' | null>(null);
  useMe();
  const { data: tree } = useTree();
  const list = useList(scope === 'list' ? id : undefined);
  const { data: users = [] } = useUsers();
  const fields = useFieldsForScope(scopeRef);
  const savedQ = useSavedViews(scopeRef);
  const saved = useMemo(() => savedQ.data?.views ?? [], [savedQ.data]);
  const { update: updateView } = useViewMutations(scopeRef);

  // ── which view is on screen ──
  const param = params.get('view');
  /** the Doc tab: the location's docs instead of tasks */
  const docMode = param === 'doc' && scope !== 'everything';
  const defaultView = saved.find((v) => v.isDefault && v.visibility === 'personal') ?? saved.find((v) => v.isDefault && v.visibility === 'shared') ?? null;
  const savedView: SavedView | null = param && !VIEW_TYPES.includes(param as ViewType) ? saved.find((v) => v.id === param) ?? null : !param ? defaultView : null;
  const viewType: ViewType = savedView?.type ?? (VIEW_TYPES.includes(param as ViewType) ? (param as ViewType) : 'list');
  const currentKey = savedView?.id ?? viewType;
  const waitingForViews = savedQ.isLoading && (!param || !VIEW_TYPES.includes(param as ViewType));

  // ── working config: saved view config (or built-in defaults) + unsaved local edits ──
  const [drafts, setDrafts] = useState<Record<string, ViewConfig>>({});
  useEffect(() => setDrafts({}), [scope, id]);
  const baseConfig = useMemo<ViewConfig>(() => savedView?.config ?? loadBuiltin(scopeRef, viewType) ?? initialConfig(viewType, defaultConfig()),
    [savedView, scopeRef, viewType]);
  const config = drafts[currentKey] ?? baseConfig;
  const dirty = !!savedView && !!drafts[currentKey] && !same(drafts[currentKey], savedView.config);
  const builtinCustomized = !savedView && !same(config, initialConfig(viewType, defaultConfig()));
  const setConfig = (patch: Partial<ViewConfig>) => {
    const next = { ...config, ...patch };
    if (!savedView) saveBuiltin(scopeRef, viewType, next); // built-ins remember their setup per viewer
    setDrafts((d) => ({ ...d, [currentKey]: next }));
  };
  const select = (key: string) => {
    const p = new URLSearchParams(params);
    p.set('view', key);
    setParams(p, { replace: true });
  };
  const saveView = async () => {
    if (!savedView) return;
    await updateView.mutateAsync({ id: savedView.id, config });
    setDrafts((d) => { const n = { ...d }; delete n[currentKey]; return n; });
    toast.ok('View saved');
  };
  const revert = () => {
    if (!savedView) saveBuiltin(scopeRef, viewType, null);
    setDrafts((d) => { const n = { ...d }; delete n[currentKey]; if (!savedView) n[currentKey] = initialConfig(viewType, defaultConfig()); return n; });
  };

  const title = useMemo(() => {
    if (scope === 'everything') return 'Everything';
    if (scope === 'list') return list.data?.name ?? '';
    for (const s of tree?.spaces ?? []) {
      if (scope === 'space' && s.id === id) return s.name;
      for (const f of s.folders) if (scope === 'folder' && f.id === id) return `${s.name} › ${f.name}`;
    }
    return '';
  }, [scope, id, tree, list.data]);

  // ── tasks ──
  const filter: FilterGroup | undefined = useMemo(() => {
    const f = cleanFilter(config.filters);
    const me = { field: 'assignee', op: 'any_of' as const, value: ['me'] };
    if (mine) return f ? { op: 'and', conditions: [f, me] } : { op: 'and', conditions: [me] };
    return f;
  }, [config.filters, mine]);
  const sort = config.sort.length ? config.sort : scope === 'list' ? undefined : [{ field: 'status', dir: 'asc' }];
  const { data: tasks, isLoading, error } = useTasks({
    listId: scope === 'list' ? id : undefined,
    folderId: scope === 'folder' ? id : undefined,
    spaceId: scope === 'space' ? id : undefined,
    includeClosed: config.showClosed,
    includeSubtasks: config.showSubtasks || undefined,
    filter: filter ? JSON.stringify(filter) : undefined,
    q: q || undefined,
    sort: sort ? JSON.stringify(sort) : undefined,
  }, !waitingForViews && !docMode);

  const listNames = useMemo(() => {
    const m = new Map<string, string>();
    for (const s of tree?.spaces ?? []) for (const l of [...s.lists, ...s.folders.flatMap((f) => f.lists)]) m.set(l.id, l.name);
    return m;
  }, [tree]);
  const decorated: Task[] = useMemo(() => (tasks ?? []).map((t) => ({ ...t, listName: listNames.get(t.listId) })), [tasks, listNames]);

  const statuses = scope === 'list' ? list.data?.statuses : undefined;
  const shownStatuses = useMemo(() => statuses?.filter((s) => config.showClosed || s.group !== 'closed'), [statuses, config.showClosed]);
  const groupable = viewType === 'list' || viewType === 'board' || viewType === 'table';
  const groupBy = groupable ? config.groupBy : 'none';
  const groups = useMemo(
    () => groupTasks(decorated, groupBy, { statuses: groupBy === 'status' ? shownStatuses : undefined, users, fields }),
    [decorated, groupBy, shownStatuses, users, fields],
  );
  const level = scope === 'list' ? list.data?._perms.level : undefined;
  const canCreate = scope === 'list' && (level === 'edit' || level === 'full');
  const containerLevel = useMemo(() => {
    if (scope === 'list') return level;
    for (const s of tree?.spaces ?? []) {
      if (scope === 'space' && s.id === id) return s._perms.level;
      for (const f of s.folders) if (scope === 'folder' && f.id === id) return f._perms.level;
    }
    return undefined;
  }, [scope, id, level, tree]);

  // ── filter sources ──
  const spaceId = scope === 'space' ? id : scope === 'list' ? list.data?.spaceId
    : scope === 'folder' ? tree?.spaces.find((s) => s.folders.some((f) => f.id === id))?.id : undefined;
  const { data: tags = [] } = useTags(spaceId);
  const spaceDetail = useQuery({
    queryKey: ['space', spaceId],
    queryFn: () => api.get<{ statuses: Status[] }>(`/hierarchy/spaces/${spaceId}`),
    enabled: !!spaceId && scope !== 'list',
    staleTime: 60_000,
  });
  const statusOptions: StatusOption[] = useMemo(() => {
    const m = new Map<string, StatusOption>();
    const add = (s: Status | null | undefined) => {
      if (!s) return;
      const k = s.name.toLowerCase();
      const cur = m.get(k) ?? { name: s.name, color: s.color, group: s.group, ids: [] };
      if (!cur.ids.includes(s.id)) cur.ids.push(s.id);
      m.set(k, cur);
    };
    (statuses ?? spaceDetail.data?.statuses ?? []).forEach(add);
    decorated.forEach((t) => add(t.status));
    const order = { open: 0, active: 1, done: 2, closed: 3 };
    return [...m.values()].sort((a, b) => order[a.group] - order[b.group]);
  }, [statuses, spaceDetail.data, decorated]);
  const sources: FilterSources = { statuses: statusOptions, users, tags, fields };

  const extraColumns = useMemo(() => config.columns.filter((k) => k.startsWith('cf:')).map((k) => fields.find((f) => `cf:${f.id}` === k)).filter((f) => !!f).map((f) => ({
    key: f!.id, header: f!.name, width: config.columnWidths[`cf:${f!.id}`] ?? 140,
    cell: (t: Task) => <FieldValueCell field={f!} task={t} editable={t._perms.level === 'edit' || t._perms.level === 'full'} />,
  })), [config.columns, config.columnWidths, fields]);

  if (scope === 'list' && list.error) return <Empty title="List not found">It may have been deleted, or you don’t have access to it.</Empty>;

  const prefKey = `${scope}:${id ?? ''}:${currentKey}`;
  const body = () => {
    if (isLoading || waitingForViews) return <Loading />;
    if (error) return <Empty title="Couldn’t load tasks">{String((error as Error).message)}</Empty>;
    switch (viewType) {
      case 'board':
        return <BoardView tasks={decorated} groups={groups} listId={scope === 'list' ? id : undefined} statuses={statuses} reorderable={scope === 'list' && !config.sort.length} canCreate={canCreate} />;
      case 'table':
        return <TableView groups={groups} statuses={statuses} listId={scope === 'list' ? id : undefined} canCreate={canCreate} scope={scope} fields={fields} config={config} onConfig={setConfig} />;
      case 'calendar':
        return <CalendarView tasks={decorated} config={config} prefKey={prefKey} listId={scope === 'list' ? id : undefined} canCreate={canCreate} />;
      case 'gantt':
        return <GanttView tasks={decorated} prefKey={prefKey} />;
      default:
        return (
          <>
            <ListView tasks={decorated} groups={groups} listId={scope === 'list' ? id : undefined} statuses={statuses}
              reorderable={scope === 'list' && groupBy === 'status' && !config.sort.length} canCreate={canCreate} extraColumns={extraColumns} />
            {!decorated.length && !canCreate && <Empty title="No tasks here">{mine || filter ? 'Nothing matches the current filters.' : 'Tasks you can see will show up here.'}</Empty>}
          </>
        );
    }
  };

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        title={title}
        icon={scope === 'everything' ? <Layers className="size-5 text-muted" /> : scope === 'list' ? <ListIcon className="size-5 text-muted" /> : undefined}
      >
        {scope === 'list' && list.data && level === 'full' && (
          <Popover align="end" width={240} trigger={(p) => <IconButton {...p} label="List settings"><MoreHorizontal className="size-4" /></IconButton>}>
            {(close) => (
              <>
                <MenuItem icon={<Share2 className="size-4" />} onClick={() => { close(); setDialog('share'); }}>Sharing & permissions</MenuItem>
                <MenuItem icon={<CircleDot className="size-4" />} onClick={() => { close(); setDialog('statuses'); }}>Statuses</MenuItem>
                <ManageFieldsMenuItem scope={{ type: 'list', id: list.data!.id, name: list.data!.name }} onDone={close} />
                <SaveListAsTemplateMenuItem listId={list.data!.id} listName={list.data!.name} onDone={close} />
                <ListIntegrationMenuItems list={list.data!} onDone={close} />
              </>
            )}
          </Popover>
        )}
      </PageHeader>
      {scope === 'list' && list.data && <ListLinkBanner list={list.data} />}

      <div className="border-b border-app px-5">
        <ViewTabs scope={scopeRef} views={saved} canShare={!!savedQ.data?.canShare} current={docMode ? 'doc' : currentKey} defaultId={defaultView?.id ?? null}
          onSelect={select} draftConfig={config}
          extraTabs={scope === 'everything' ? [] : [{ key: 'doc', label: 'Doc', icon: <FileText className="size-4" /> }]} />
      </div>
      {!docMode && <div className="flex flex-wrap items-center gap-2 border-b border-app px-5 py-1.5">
        <div className="relative">
          <Search className="pointer-events-none absolute left-2 top-2 size-4 text-subtle" />
          <Input className="h-8 w-48 pl-7" placeholder="Search tasks…" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <Button size="sm" variant={mine ? 'primary' : 'secondary'} onClick={() => setMine(!mine)} title="Only tasks assigned to me (not saved)"><UserIcon className="size-3.5" />Me</Button>
        {(dirty || builtinCustomized) && (
          <div className={cx('flex items-center gap-1 rounded-md px-1 py-0.5', dirty && 'bg-amber-50 dark:bg-amber-500/10')}>
            {dirty && <span className="px-1 text-xs text-amber-700 dark:text-amber-300">Unsaved changes</span>}
            {dirty && savedView?.canEdit && <Button size="sm" variant="primary" loading={updateView.isPending} onClick={() => void saveView()}><Save className="size-3.5" />Save</Button>}
            <NewViewButton scope={scopeRef} canShare={!!savedQ.data?.canShare} config={config} initialType={viewType} onCreated={(vid) => {
              setDrafts((d) => { const n = { ...d }; delete n[currentKey]; return n; });
              if (!savedView) saveBuiltin(scopeRef, viewType, null);
              select(vid);
            }}
              trigger={(p) => <Button {...p} size="sm" variant={dirty && savedView?.canEdit ? 'ghost' : 'secondary'}><Save className="size-3.5" />Save as view</Button>} />
            <Button size="sm" variant="ghost" onClick={revert} title={savedView ? 'Discard changes' : 'Reset to defaults'}><RotateCcw className="size-3.5" />{savedView ? 'Revert' : 'Reset'}</Button>
          </div>
        )}
        <div className="ml-auto flex items-center gap-2">
          <FilterButton value={config.filters} onChange={(filters) => setConfig({ filters })} sources={sources} />
          <SortButton config={config} onChange={setConfig} fields={fields} />
          {(viewType === 'table' || viewType === 'list') && <ColumnsButton config={config} onChange={setConfig} fields={fields} scope={scope} mode={viewType} />}
          <OptionsButton config={config} onChange={setConfig} type={viewType} groups={groupOptions(scope, fields)} />
        </div>
      </div>}

      <div className={cx('min-h-0 flex-1', viewType === 'list' && !docMode ? 'overflow-y-auto px-5' : 'overflow-hidden')}>
        {docMode
          ? <DocsView containerType={scope as 'space' | 'folder' | 'list'} containerId={id!} canCreate={containerLevel === 'edit' || containerLevel === 'full'} />
          : body()}
      </div>

      {dialog === 'share' && list.data && <ShareDialog type="list" id={list.data.id} name={list.data.name} onClose={() => setDialog(null)} />}
      {dialog === 'statuses' && list.data && <StatusEditor type="list" id={list.data.id} name={list.data.name} onClose={() => setDialog(null)} />}
    </div>
  );
}
