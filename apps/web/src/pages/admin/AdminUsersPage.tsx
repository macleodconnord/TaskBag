import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Users } from 'lucide-react';
import { useState } from 'react';
import { api } from '@/lib/api';
import { timeAgo } from '@/lib/format';
import { keys, useMe } from '@/lib/queries';
import type { User } from '@/lib/types';
import { toast } from '@/components/toast';
import { Avatar, Badge, Button, Empty, Field, Input, Loading, Modal, PageHeader, Select } from '@/components/ui';

export function AdminUsersPage() {
  const { data: me } = useMe();
  const qc = useQueryClient();
  const { data: users, isLoading } = useQuery({ queryKey: ['admin-users'], queryFn: () => api.get<User[]>('/users?all=true') });
  const [creating, setCreating] = useState(false);
  const isAdmin = me && (me.user.role === 'owner' || me.user.role === 'admin');
  if (me && !isAdmin) return <Empty title="Admins only" />;
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['admin-users'] });
    void qc.invalidateQueries({ queryKey: keys.users });
  };
  const patch = async (u: User, body: Record<string, unknown>) => {
    await api.patch(`/users/${u.id}`, body);
    toast.ok('User updated');
    refresh();
  };
  const people = (users ?? []).filter((u) => !u.isSystem);

  return (
    <div className="flex h-full flex-col">
      <PageHeader title="Users" icon={<Users className="size-5 text-muted" />}>
        <Button variant="primary" size="sm" onClick={() => setCreating(true)}><Plus className="size-3.5" />Add user</Button>
      </PageHeader>
      <div className="min-h-0 flex-1 overflow-y-auto p-5">
        <p className="mb-4 max-w-3xl text-sm text-muted">
          People are created automatically the first time they sign in with Microsoft. Add someone here to assign work to them before their first sign-in; they’re matched by email.
          Owners and admins see everything. Members get what sharing gives them (by default, edit on everything through <b>All Members</b>). Guests only see what is shared with them directly.
        </p>
        {isLoading ? <Loading /> : (
          <table className="w-full max-w-5xl text-sm">
            <thead>
              <tr className="border-b border-app text-left text-xs text-muted">
                <th className="py-2 font-medium">Name</th>
                <th className="font-medium">Role</th>
                <th className="font-medium">Sign-in</th>
                <th className="font-medium">Last login</th>
                <th className="font-medium">Status</th>
              </tr>
            </thead>
            <tbody>
              {people.map((u) => {
                const self = u.id === me?.user.id;
                const ownerOnly = (u.role === 'owner' || u.role === 'admin') && me?.user.role !== 'owner';
                return (
                  <tr key={u.id} className="border-b border-app">
                    <td className="py-2">
                      <div className="flex items-center gap-2">
                        <Avatar user={u} size={28} />
                        <div>
                          <div className="font-medium">{u.displayName}</div>
                          <div className="text-xs text-muted">{u.email}</div>
                        </div>
                      </div>
                    </td>
                    <td>
                      <Select className="h-7 w-28" value={u.role} disabled={self || ownerOnly}
                        onChange={(e) => void patch(u, { role: e.target.value })}>
                        {me?.user.role === 'owner' && <option value="owner">Owner</option>}
                        <option value="admin" disabled={me?.user.role !== 'owner'}>Admin</option>
                        <option value="member">Member</option>
                        <option value="guest">Guest</option>
                      </Select>
                    </td>
                    <td>
                      {u.isBreakglass ? <Badge color="#d97706">Break-glass</Badge> : u.entraLinked ? <Badge color="#2563eb">Microsoft</Badge> : u.isPlaceholder ? <Badge>Not signed in yet</Badge> : <Badge>Local</Badge>}
                    </td>
                    <td className="text-muted">{u.lastLoginAt ? timeAgo(u.lastLoginAt) : '—'}</td>
                    <td>
                      {self ? <span className="text-xs text-muted">You</span> : (
                        <Button size="sm" variant={u.isActive ? 'secondary' : 'primary'} disabled={ownerOnly} onClick={() => void patch(u, { isActive: !u.isActive })}>
                          {u.isActive ? 'Deactivate' : 'Reactivate'}
                        </Button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
      {creating && <CreateUserDialog onClose={() => setCreating(false)} onCreated={refresh} canAdmin={me?.user.role === 'owner'} />}
    </div>
  );
}

function CreateUserDialog({ onClose, onCreated, canAdmin }: { onClose: () => void; onCreated: () => void; canAdmin: boolean }) {
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [role, setRole] = useState('member');
  const [busy, setBusy] = useState(false);
  return (
    <Modal open onClose={onClose} title="Add user" width={420}
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" loading={busy} disabled={!email || !name}
        onClick={async () => { setBusy(true); try { await api.post('/users', { email, displayName: name, role }); onCreated(); onClose(); toast.ok('User added'); } finally { setBusy(false); } }}>Add</Button></>}>
      <div className="space-y-3">
        <Field label="Email" hint="— must match their Microsoft sign-in"><Input type="email" autoFocus value={email} onChange={(e) => setEmail(e.target.value)} /></Field>
        <Field label="Name"><Input value={name} onChange={(e) => setName(e.target.value)} /></Field>
        <Field label="Role">
          <Select value={role} onChange={(e) => setRole(e.target.value)}>
            {canAdmin && <option value="admin">Admin</option>}
            <option value="member">Member</option>
            <option value="guest">Guest</option>
          </Select>
        </Field>
      </div>
    </Modal>
  );
}
