import { useQueryClient } from '@tanstack/react-query';
import { Plus, Trash2, Users } from 'lucide-react';
import { useState } from 'react';
import { api } from '@/lib/api';
import { keys, useGroups, useMe, useUsers } from '@/lib/queries';
import type { Group } from '@/lib/types';
import { UserSearchList } from '@/components/pickers';
import { toast } from '@/components/toast';
import { AvatarStack, Badge, Button, Empty, Field, Input, Loading, Modal, PageHeader, Popover, useDialogs } from '@/components/ui';

export function AdminGroupsPage() {
  const { data: me } = useMe();
  const { data: groups, isLoading } = useGroups();
  const { data: users = [] } = useUsers();
  const qc = useQueryClient();
  const { confirm } = useDialogs();
  const [editing, setEditing] = useState<Group | 'new' | null>(null);
  if (me && me.user.role !== 'owner' && me.user.role !== 'admin') return <Empty title="Admins only" />;
  return (
    <div className="flex h-full flex-col">
      <PageHeader title="Groups" icon={<Users className="size-5 text-muted" />}>
        <Button variant="primary" size="sm" onClick={() => setEditing('new')}><Plus className="size-3.5" />New group</Button>
      </PageHeader>
      <div className="min-h-0 flex-1 overflow-y-auto p-5">
        <p className="mb-4 max-w-3xl text-sm text-muted">
          Use groups to share spaces, folders and lists with several people at once. Link a group to an Entra security group (object ID) and its members are kept in sync each time someone signs in.
        </p>
        {isLoading ? <Loading /> : (
          <div className="max-w-4xl divide-y divide-[var(--border)] rounded-lg border border-app">
            {groups?.map((g) => {
              const members = g.members.map((m) => users.find((u) => u.id === m.userId)).filter((u): u is NonNullable<typeof u> => !!u);
              return (
                <div key={g.id} className="flex items-center gap-3 px-4 py-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 font-medium">
                      {g.name}
                      {g.isSystem && <Badge>System</Badge>}
                      {g.entraGroupId && <Badge color="#2563eb">Entra</Badge>}
                    </div>
                    {g.description && <div className="text-sm text-muted">{g.description}</div>}
                  </div>
                  <AvatarStack users={members} max={6} />
                  <span className="w-20 text-right text-sm text-muted">{g.members.length} member{g.members.length === 1 ? '' : 's'}</span>
                  {!g.isSystem && (
                    <>
                      <Button size="sm" onClick={() => setEditing(g)}>Edit</Button>
                      <button className="text-subtle hover:text-red-600" aria-label="Delete group" onClick={async () => {
                        if (await confirm({ title: `Delete group “${g.name}”?`, body: 'Anything shared with this group stops being shared with its members.', confirm: 'Delete', danger: true })) {
                          await api.delete(`/users/groups/${g.id}`);
                          void qc.invalidateQueries({ queryKey: keys.groups });
                        }
                      }}><Trash2 className="size-4" /></button>
                    </>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
      {editing && <GroupDialog group={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />}
    </div>
  );
}

function GroupDialog({ group, onClose }: { group: Group | null; onClose: () => void }) {
  const qc = useQueryClient();
  const { data: users = [] } = useUsers();
  const [name, setName] = useState(group?.name ?? '');
  const [description, setDescription] = useState(group?.description ?? '');
  const [entra, setEntra] = useState(group?.entraGroupId ?? '');
  const [memberIds, setMemberIds] = useState<string[]>(group?.members.filter((m) => m.source === 'local').map((m) => m.userId) ?? []);
  const entraMembers = group?.members.filter((m) => m.source === 'entra') ?? [];
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try {
      const body = { name, description: description || null, entraGroupId: entra || null, memberIds };
      if (group) await api.patch(`/users/groups/${group.id}`, body);
      else await api.post('/users/groups', body);
      void qc.invalidateQueries({ queryKey: keys.groups });
      toast.ok('Group saved');
      onClose();
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal open onClose={onClose} title={group ? 'Edit group' : 'New group'} width={480}
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" loading={busy} disabled={!name.trim()} onClick={save}>Save</Button></>}>
      <div className="space-y-3">
        <Field label="Name"><Input autoFocus value={name} onChange={(e) => setName(e.target.value)} /></Field>
        <Field label="Description"><Input value={description} onChange={(e) => setDescription(e.target.value)} /></Field>
        <Field label="Entra group object ID" hint="(optional)"><Input value={entra} onChange={(e) => setEntra(e.target.value.trim())} placeholder="00000000-0000-0000-0000-000000000000" /></Field>
        <div>
          <div className="mb-1 flex items-center justify-between">
            <span className="text-xs font-medium text-muted">Members</span>
            <Popover align="end" width={260} trigger={(p) => <Button {...p} size="sm"><Plus className="size-3.5" />Add</Button>}>
              <UserSearchList selected={memberIds} onToggle={(id) => setMemberIds((m) => (m.includes(id) ? m.filter((x) => x !== id) : [...m, id]))} />
            </Popover>
          </div>
          <div className="flex flex-wrap gap-1.5">
            {memberIds.map((id) => {
              const u = users.find((x) => x.id === id);
              return <span key={id} className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-xs">{u?.displayName ?? 'Unknown'}<button onClick={() => setMemberIds((m) => m.filter((x) => x !== id))}>×</button></span>;
            })}
            {!memberIds.length && <span className="text-sm text-subtle">No local members</span>}
          </div>
          {entraMembers.length > 0 && <p className="mt-2 text-xs text-muted">{entraMembers.length} more synced from Entra (managed at sign-in).</p>}
        </div>
      </div>
    </Modal>
  );
}
