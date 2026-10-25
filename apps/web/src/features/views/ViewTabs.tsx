import { VIEW_TYPES, type ViewConfig, type ViewType } from '@app/shared';
import { CalendarDays, ChartGantt, Columns3, Copy, List as ListIcon, Lock, MoreHorizontal, Pencil, Plus, Star, StarOff, Table2, Trash2, Users } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { Button, Checkbox, cx, Field, Input, MenuItem, MenuSeparator, Popover, useDialogs } from '@/components/ui';
import { toast } from '@/components/toast';
import type { SavedView, ScopeRef } from './api';
import { useViewMutations } from './api';
import { VIEW_LABELS } from './config';

export const VIEW_ICONS: Record<ViewType, ReactNode> = {
  list: <ListIcon className="size-4" />,
  board: <Columns3 className="size-4" />,
  table: <Table2 className="size-4" />,
  calendar: <CalendarDays className="size-4" />,
  gantt: <ChartGantt className="size-4" />,
};

/**
 * Tab bar: the built-in views (unsaved, per-viewer) followed by the scope's saved views.
 * `current` is a view type for a built-in or a saved view id.
 */
export function ViewTabs({ scope, views, canShare, current, defaultId, onSelect, draftConfig, extraTabs = [] }: {
  scope: ScopeRef;
  views: SavedView[];
  canShare: boolean;
  current: string;
  defaultId: string | null;
  onSelect: (key: string) => void;
  /** config of the view on screen, offered as the starting point for a new view */
  draftConfig: ViewConfig;
  /** more built-in tabs after the task views (e.g. Doc) */
  extraTabs?: Array<{ key: string; label: string; icon: ReactNode }>;
}) {
  const { update, remove } = useViewMutations(scope);
  const { prompt, confirm } = useDialogs();

  const rename = async (v: SavedView) => {
    const name = await prompt({ title: 'Rename view', label: 'Name', initial: v.name, confirm: 'Rename' });
    if (name?.trim()) update.mutate({ id: v.id, name: name.trim() });
  };
  const del = async (v: SavedView) => {
    if (!(await confirm({ title: `Delete “${v.name}”?`, body: v.visibility === 'shared' ? 'This removes the view for everyone.' : 'This removes your personal view.', confirm: 'Delete', danger: true }))) return;
    await remove.mutateAsync(v.id);
    if (current === v.id) onSelect('list');
    toast.ok('View deleted');
  };

  return (
    <div className="flex min-w-0 items-center gap-0.5 overflow-x-auto" role="tablist" aria-label="Views">
      {VIEW_TYPES.map((t) => (
        <Tab key={t} active={current === t} icon={VIEW_ICONS[t]} onClick={() => onSelect(t)} label={VIEW_LABELS[t]} />
      ))}
      {extraTabs.map((t) => (
        <Tab key={t.key} active={current === t.key} icon={t.icon} onClick={() => onSelect(t.key)} label={t.label} />
      ))}
      {views.length > 0 && <span className="mx-1.5 h-5 w-px shrink-0 bg-[var(--border)]" />}
      {views.map((v) => (
        <Tab key={v.id} active={current === v.id} icon={VIEW_ICONS[v.type]} onClick={() => onSelect(v.id)}
          label={
            <>
              {v.name}
              {v.visibility === 'personal' && <Lock className="size-3 text-subtle" aria-label="Personal" />}
              {defaultId === v.id && <Star className="size-3 fill-amber-400 text-amber-400" aria-label="Default view" />}
            </>
          }
          menu={current === v.id ? (
            <Popover width={230} trigger={(p) => (
              <button {...p} className="ml-0.5 rounded p-0.5 text-subtle hover-bg hover:text-app" aria-label={`${v.name} options`}><MoreHorizontal className="size-3.5" /></button>
            )}>
              {(close) => (
                <>
                  {v.canEdit && <MenuItem icon={<Pencil className="size-4" />} onClick={() => { close(); void rename(v); }}>Rename</MenuItem>}
                  {v.canEdit && (v.isDefault
                    ? <MenuItem icon={<StarOff className="size-4" />} onClick={() => { close(); update.mutate({ id: v.id, isDefault: false }); }}>Remove as default</MenuItem>
                    : <MenuItem icon={<Star className="size-4" />} onClick={() => { close(); update.mutate({ id: v.id, isDefault: true }); }}>
                        {v.visibility === 'shared' ? 'Set as default for everyone' : 'Set as my default'}
                      </MenuItem>)}
                  {v.canEdit && v.visibility === 'personal' && canShare && (
                    <MenuItem icon={<Users className="size-4" />} onClick={() => { close(); update.mutate({ id: v.id, visibility: 'shared' }); }}>Share with everyone here</MenuItem>
                  )}
                  {v.canEdit && v.visibility === 'shared' && (
                    <MenuItem icon={<Lock className="size-4" />} onClick={() => { close(); update.mutate({ id: v.id, visibility: 'personal' }); }}>Make personal</MenuItem>
                  )}
                  <NewViewMenuItem scope={scope} canShare={canShare} base={v} config={draftConfig} onCreated={(id) => { close(); onSelect(id); }} />
                  {v.canEdit && (
                    <>
                      <MenuSeparator />
                      <MenuItem danger icon={<Trash2 className="size-4" />} onClick={() => { close(); void del(v); }}>Delete view</MenuItem>
                    </>
                  )}
                  {!v.canEdit && <div className="px-2 py-1.5 text-xs text-subtle">Shared view — you can use it, and save changes as your own view.</div>}
                </>
              )}
            </Popover>
          ) : undefined}
        />
      ))}
      <NewViewButton scope={scope} canShare={canShare} config={draftConfig} onCreated={onSelect} />
    </div>
  );
}

function Tab({ active, icon, label, onClick, menu }: { active: boolean; icon: ReactNode; label: ReactNode; onClick: () => void; menu?: ReactNode }) {
  return (
    <div className={cx('inline-flex h-9 shrink-0 items-center border-b-2', active ? 'border-accent-600 text-app' : 'border-transparent text-muted hover:text-app')}>
      <button role="tab" aria-selected={active} onClick={onClick} className="inline-flex h-8 items-center gap-1.5 whitespace-nowrap pl-2.5 pr-1 text-sm font-medium">
        {icon}
        {label}
      </button>
      {menu}
      <span className="w-1.5" />
    </div>
  );
}

function NewViewMenuItem({ scope, canShare, base, config, onCreated }: { scope: ScopeRef; canShare: boolean; base: SavedView; config: ViewConfig; onCreated: (id: string) => void }) {
  const { create } = useViewMutations(scope);
  return (
    <MenuItem icon={<Copy className="size-4" />} onClick={async () => {
      const v = await create.mutateAsync({ type: base.type, name: `${base.name} (copy)`, visibility: base.visibility === 'shared' && canShare && base.canEdit ? 'shared' : 'personal', config });
      onCreated(v.id);
    }}>Duplicate{config !== base.config ? ' with changes' : ''}</MenuItem>
  );
}

/** "+ View" popover: name, type, personal/shared, default. Also used for "Save as new view". */
export function NewViewButton({ scope, canShare, config, onCreated, initialType, trigger }: {
  scope: ScopeRef; canShare: boolean; config: ViewConfig; onCreated: (id: string) => void; initialType?: ViewType;
  trigger?: (p: Record<string, unknown>) => ReactNode;
}) {
  return (
    <Popover width={320} align="start" trigger={(p) => trigger ? trigger(p) : (
      <button {...p} className="ml-1 inline-flex h-7 shrink-0 items-center gap-1 rounded-md px-2 text-sm text-muted hover-bg hover:text-app"><Plus className="size-4" />View</button>
    )}>
      {(close) => <NewViewForm scope={scope} canShare={canShare} config={config} initialType={initialType} onDone={(id) => { close(); if (id) onCreated(id); }} />}
    </Popover>
  );
}

function NewViewForm({ scope, canShare, config, initialType, onDone }: { scope: ScopeRef; canShare: boolean; config: ViewConfig; initialType?: ViewType; onDone: (id?: string) => void }) {
  const { create } = useViewMutations(scope);
  const [type, setType] = useState<ViewType>(initialType ?? 'list');
  const [name, setName] = useState('');
  const [shared, setShared] = useState(false);
  const [isDefault, setIsDefault] = useState(false);
  const [keep, setKeep] = useState(true);
  const submit = async () => {
    const v = await create.mutateAsync({
      type, name: name.trim() || VIEW_LABELS[type], visibility: shared ? 'shared' : 'personal', isDefault,
      config: keep ? config : { ...config, filters: undefined, sort: [], columns: [], columnWidths: {} },
    });
    toast.ok(`View “${v.name}” created`);
    onDone(v.id);
  };
  return (
    <form className="flex flex-col gap-3 p-2" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
      <div className="text-sm font-semibold">New view</div>
      <div className="grid grid-cols-5 gap-1">
        {VIEW_TYPES.map((t) => (
          <button type="button" key={t} onClick={() => setType(t)} aria-pressed={type === t}
            className={cx('flex flex-col items-center gap-1 rounded-md border px-1 py-1.5 text-[11px]', type === t ? 'border-accent-500 bg-accent-50 text-accent-700 dark:bg-accent-500/15 dark:text-accent-100' : 'border-app text-muted hover-bg')}>
            {VIEW_ICONS[t]}{VIEW_LABELS[t]}
          </button>
        ))}
      </div>
      <Field label="Name"><Input autoFocus value={name} placeholder={VIEW_LABELS[type]} onChange={(e) => setName(e.target.value)} maxLength={100} /></Field>
      <div className="flex flex-col gap-1.5">
        <label className="flex items-center gap-2 text-sm"><input type="radio" className="accent-accent-600" checked={!shared} onChange={() => setShared(false)} />
          <Lock className="size-3.5 text-muted" />Personal <span className="text-xs text-subtle">only you</span></label>
        <label className={cx('flex items-center gap-2 text-sm', !canShare && 'opacity-50')} title={canShare ? undefined : scope.type === 'everything' ? 'Only admins can share views here' : 'Needs edit access to this location'}>
          <input type="radio" className="accent-accent-600" checked={shared} disabled={!canShare} onChange={() => setShared(true)} />
          <Users className="size-3.5 text-muted" />Shared <span className="text-xs text-subtle">everyone who can see this</span></label>
      </div>
      <Checkbox checked={keep} onChange={setKeep} label={<span className="text-sm">Start from current filters &amp; columns</span>} />
      <Checkbox checked={isDefault} onChange={setIsDefault} label={<span className="text-sm">{shared ? 'Default view for everyone' : 'My default view here'}</span>} />
      <div className="flex justify-end gap-2">
        <Button type="button" size="sm" onClick={() => onDone()}>Cancel</Button>
        <Button type="submit" size="sm" variant="primary" loading={create.isPending}>Create view</Button>
      </div>
    </form>
  );
}
