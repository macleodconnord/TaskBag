import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Globe, Lock, Plus, Trash2, Users as UsersIcon } from 'lucide-react';
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { useGroups, useUsers } from '@/lib/queries';
import { Avatar, Button, Modal, Popover, Select, MenuItem, Loading, cx } from './ui';
import { UserSearchList } from './pickers';
import { toast } from './toast';

type Level = 'view' | 'comment' | 'edit' | 'full';
type Entry = { principalType: 'user' | 'group'; principalId: string; level: Level };
type Sharing = {
  mode: 'inherit' | 'additive' | 'override';
  chain: Array<{ scopeId: string; objectType: string; objectId: string; mode: string; entries: Entry[] }>;
  users: Array<{ id: string; displayName: string; email: string; role: string }>;
  groups: Array<{ id: string; name: string }>;
  canEdit: boolean;
};

const LEVELS: Array<{ value: Level; label: string; hint: string }> = [
  { value: 'view', label: 'View', hint: 'See it and its contents' },
  { value: 'comment', label: 'Comment', hint: 'View, plus comment' },
  { value: 'edit', label: 'Edit', hint: 'Change fields, create and move items' },
  { value: 'full', label: 'Full', hint: 'Edit, delete and manage sharing' },
];

/** Share dialog (permissions.md §2): inherit, share with extra people (additive) or make private / customize (override). */
export function ShareDialog({ type, id, name, onClose }: { type: 'space' | 'folder' | 'list' | 'task' | 'doc'; id: string; name: string; onClose: () => void }) {
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({ queryKey: ['sharing', type, id], queryFn: () => api.get<Sharing>(`/hierarchy/sharing/${type}/${id}`) });
  const { data: users = [] } = useUsers();
  const { data: groups = [] } = useGroups();
  const [mode, setMode] = useState<Sharing['mode']>('inherit');
  const [entries, setEntries] = useState<Entry[]>([]);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!data) return;
    setMode(data.mode);
    setEntries(data.mode === 'inherit' ? [] : data.chain[0]?.entries ?? []);
  }, [data]);

  const inherited = data ? (data.mode === 'inherit' ? data.chain : data.chain.slice(1)) : [];
  const nameOf = (e: Entry) => e.principalType === 'user'
    ? users.find((u) => u.id === e.principalId)?.displayName ?? data?.users.find((u) => u.id === e.principalId)?.displayName ?? 'Unknown user'
    : groups.find((g) => g.id === e.principalId)?.name ?? data?.groups.find((g) => g.id === e.principalId)?.name ?? 'Unknown group';

  const add = (e: Entry) => setEntries((cur) => (cur.some((c) => c.principalId === e.principalId) ? cur : [...cur, e]));

  const switchMode = (m: Sharing['mode']) => {
    if (m === 'override' && mode !== 'override') {
      // "Customize": start from everyone who currently has access
      const effective = new Map<string, Entry>();
      for (const s of data?.chain ?? []) for (const e of s.entries) if (!effective.has(e.principalId)) effective.set(e.principalId, e);
      for (const e of entries) effective.set(e.principalId, e);
      setEntries([...effective.values()]);
    }
    setMode(m);
  };

  const save = async () => {
    setSaving(true);
    try {
      const r = await api.put<{ yourLevel: string }>(`/hierarchy/sharing/${type}/${id}`, { mode, entries: mode === 'inherit' ? [] : entries });
      toast.ok('Sharing updated');
      if (r.yourLevel === 'none') toast.error('Note: you no longer have access to this item.');
      void qc.invalidateQueries();
      onClose();
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal open onClose={onClose} title={`Share “${name}”`} width={560}
      footer={data?.canEdit ? <><Button onClick={onClose}>Cancel</Button><Button variant="primary" loading={saving} onClick={save}>Save</Button></> : <Button onClick={onClose}>Close</Button>}>
      {isLoading || !data ? <Loading /> : (
        <div className="space-y-4">
          <div className="grid grid-cols-3 gap-2">
            {([
              ['inherit', <Globe key="i" className="size-4" />, 'Inherit', 'Same access as its parent'],
              ['additive', <UsersIcon key="a" className="size-4" />, 'Share with more', 'Parent access plus people below'],
              ['override', <Lock key="o" className="size-4" />, 'Private / custom', 'Only the people below'],
            ] as const).map(([m, icon, label, hint]) => (
              <button key={m} disabled={!data.canEdit} onClick={() => switchMode(m)}
                className={cx('rounded-lg border p-2.5 text-left disabled:cursor-default', mode === m ? 'border-accent-500 bg-accent-50 dark:bg-accent-500/10' : 'border-app hover-bg')}>
                <div className="flex items-center gap-1.5 text-sm font-medium">{icon}{label}</div>
                <div className="mt-0.5 text-xs text-muted">{hint}</div>
              </button>
            ))}
          </div>

          {mode !== 'inherit' && (
            <div>
              <div className="mb-1 flex items-center justify-between">
                <span className="text-xs font-semibold uppercase tracking-wide text-subtle">{mode === 'override' ? 'Who has access' : 'Also shared with'}</span>
                {data.canEdit && (
                  <Popover align="end" width={280} trigger={(p) => <Button {...p} size="sm"><Plus className="size-3.5" />Add</Button>}>
                    {(close) => (
                      <div>
                        {groups.length > 0 && (
                          <div className="mb-1 border-b border-app pb-1">
                            {groups.map((g) => (
                              <MenuItem key={g.id} icon={<UsersIcon className="size-4" />} onClick={() => { add({ principalType: 'group', principalId: g.id, level: 'edit' }); close(); }}>{g.name}</MenuItem>
                            ))}
                          </div>
                        )}
                        <UserSearchList selected={entries.filter((e) => e.principalType === 'user').map((e) => e.principalId)}
                          onToggle={(uid) => { add({ principalType: 'user', principalId: uid, level: users.find((u) => u.id === uid)?.role === 'guest' ? 'comment' : 'edit' }); close(); }} />
                      </div>
                    )}
                  </Popover>
                )}
              </div>
              <div className="divide-y divide-[var(--border)] rounded-lg border border-app">
                {entries.length === 0 && <div className="p-3 text-sm text-muted">{mode === 'override' ? 'Nobody except owners and admins.' : 'Nobody added yet.'}</div>}
                {entries.map((e) => (
                  <EntryRow key={e.principalId} name={nameOf(e)} entry={e} guest={e.principalType === 'user' && users.find((u) => u.id === e.principalId)?.role === 'guest'}
                    disabled={!data.canEdit}
                    onLevel={(level) => setEntries((cur) => cur.map((c) => (c.principalId === e.principalId ? { ...c, level } : c)))}
                    onRemove={() => setEntries((cur) => cur.filter((c) => c.principalId !== e.principalId))} />
                ))}
              </div>
            </div>
          )}

          {mode !== 'override' && inherited.length > 0 && (
            <div>
              <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-subtle">Inherited</div>
              <div className="divide-y divide-[var(--border)] rounded-lg border border-app bg-subtle">
                {inherited.flatMap((s) => s.entries.map((e) => (
                  <div key={s.scopeId + e.principalId} className="flex items-center gap-2 px-3 py-2 text-sm">
                    {e.principalType === 'group' ? <UsersIcon className="size-4 text-muted" /> : <Avatar user={{ id: e.principalId, displayName: nameOf(e) }} size={20} />}
                    <span className="flex-1">{nameOf(e)}</span>
                    <span className="text-xs text-muted">{LEVELS.find((l) => l.value === e.level)?.label} · from {s.objectType}</span>
                  </div>
                )))}
              </div>
            </div>
          )}
          <p className="text-xs text-muted">Owners and admins can always see everything. Guests can be given at most Edit.</p>
        </div>
      )}
    </Modal>
  );
}

function EntryRow({ name, entry, guest, disabled, onLevel, onRemove }: { name: string; entry: Entry; guest: boolean; disabled: boolean; onLevel: (l: Level) => void; onRemove: () => void }) {
  return (
    <div className="flex items-center gap-2 px-3 py-2 text-sm">
      {entry.principalType === 'group' ? <UsersIcon className="size-4 text-muted" /> : <Avatar user={{ id: entry.principalId, displayName: name }} size={20} />}
      <span className="flex-1 truncate">{name}{guest && <span className="ml-1 text-xs text-subtle">guest</span>}</span>
      <Select className="w-32" value={entry.level} disabled={disabled} onChange={(e) => onLevel(e.target.value as Level)}>
        {LEVELS.filter((l) => !(guest && l.value === 'full')).map((l) => <option key={l.value} value={l.value} title={l.hint}>{l.label}</option>)}
      </Select>
      {!disabled && <button className="text-subtle hover:text-red-600" onClick={onRemove} aria-label="Remove"><Trash2 className="size-4" /></button>}
    </div>
  );
}
