import { WEBHOOK_EVENT_TYPES } from '@app/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Pencil, Plus, RotateCw, Send, Trash2, Webhook } from 'lucide-react';
import { Fragment, useState } from 'react';
import { api } from '@/lib/api';
import { timeAgo } from '@/lib/format';
import { useMe, useTree, useUsers } from '@/lib/queries';
import { toast } from '@/components/toast';
import { Badge, Button, Checkbox, cx, Empty, Field, IconButton, Input, Loading, Modal, PageHeader, Select, useDialogs } from '@/components/ui';
import { CopyField, ScopeSelect } from './common';

type ScopeType = 'workspace' | 'space' | 'folder' | 'list';
interface Subscription {
  id: string;
  name: string;
  url: string;
  eventTypes: string[];
  scopeType: ScopeType;
  scopeId: string | null;
  actingUserId: string;
  actingUser: { id: string; displayName: string } | null;
  enabled: boolean;
  createdAt: string;
  pending: number;
  failed24h: number;
  lastDelivery: { status: string; httpStatus: number | null; createdAt: string } | null;
}
interface Delivery {
  id: string;
  eventId: string;
  eventType: string;
  payload: unknown;
  status: 'pending' | 'succeeded' | 'failed';
  httpStatus: number | null;
  attempts: number;
  nextAttemptAt: string;
  responseExcerpt: string | null;
  createdAt: string;
}

const QK = ['admin-webhooks'] as const;
const STATUS_CLS: Record<string, string> = {
  succeeded: 'text-emerald-700 dark:text-emerald-400',
  failed: 'text-red-700 dark:text-red-400',
  pending: 'text-amber-700 dark:text-amber-400',
};

export function AdminWebhooksPage() {
  const { data: me } = useMe();
  const qc = useQueryClient();
  const dialogs = useDialogs();
  const { data, isLoading } = useQuery({ queryKey: QK, queryFn: () => api.get<Subscription[]>('/webhooks'), refetchInterval: 15_000 });
  const [editing, setEditing] = useState<Subscription | 'new' | null>(null);
  const [secret, setSecret] = useState<{ name: string; value: string } | null>(null);
  const [logFor, setLogFor] = useState<string | null>(null);
  const scopeName = useScopeName();
  const isAdmin = me && (me.user.role === 'owner' || me.user.role === 'admin');
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: QK });
    void qc.invalidateQueries({ queryKey: ['webhook-deliveries'] });
  };

  const test = useMutation({
    mutationFn: (s: Subscription) => api.post<Delivery>(`/webhooks/subscriptions/${s.id}/test`),
    onSuccess: (d, s) => {
      if (d.status === 'succeeded') toast.ok(`Test delivered (HTTP ${d.httpStatus})`);
      else toast.error(`Test failed${d.httpStatus ? ` (HTTP ${d.httpStatus})` : ''}: ${d.responseExcerpt ?? ''}`.slice(0, 200));
      setLogFor(s.id);
      refresh();
    },
  });
  const patch = useMutation({ mutationFn: ({ id, body }: { id: string; body: Partial<Subscription> }) => api.patch(`/webhooks/subscriptions/${id}`, body), onSuccess: refresh });
  const del = useMutation({ mutationFn: (id: string) => api.delete(`/webhooks/subscriptions/${id}`), onSuccess: () => { toast.ok('Webhook deleted'); refresh(); } });
  const rotate = useMutation({
    mutationFn: (s: Subscription) => api.post<{ secret: string }>(`/webhooks/subscriptions/${s.id}/rotate-secret`),
    onSuccess: (r, s) => setSecret({ name: s.name, value: r.secret }),
  });

  if (me && !isAdmin) return <Empty title="Admins only" />;

  return (
    <div className="flex h-full flex-col">
      <PageHeader title="Outbound webhooks" icon={<Webhook className="size-5 text-muted" />}>
        <Button variant="primary" size="sm" onClick={() => setEditing('new')}><Plus className="size-3.5" />Add webhook</Button>
      </PageHeader>
      <div className="min-h-0 flex-1 overflow-y-auto p-5">
        <p className="mb-4 max-w-3xl text-sm text-muted">
          Each webhook receives a signed JSON POST for the selected events. Payloads are filtered as the <b>acting user</b>: nothing about a task that user can't view is ever sent.
          Verify the <code className="rounded bg-muted px-1">X-Signature: sha256=…</code> header (HMAC-SHA256 of the raw body with the signing secret). Failed deliveries are retried with exponential backoff, up to 8 attempts.
        </p>
        {isLoading ? <Loading /> : !data?.length ? (
          <Empty icon={<Webhook className="size-8" />} title="No webhooks yet">Add one to push task and comment events to another system.</Empty>
        ) : (
          <div className="max-w-5xl space-y-3">
            {data.map((s) => (
              <div key={s.id} className="rounded-lg border border-app">
                <div className="flex flex-wrap items-start gap-3 p-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium">{s.name}</span>
                      {!s.enabled && <Badge>Paused</Badge>}
                      {s.failed24h > 0 && <Badge color="#dc2626">{s.failed24h} failed (24h)</Badge>}
                      {s.pending > 0 && <Badge color="#d97706">{s.pending} pending</Badge>}
                    </div>
                    <div className="mt-0.5 truncate font-mono text-xs text-muted">{s.url}</div>
                    <div className="mt-1 text-xs text-muted">
                      {s.eventTypes.length ? s.eventTypes.join(', ') : 'All events'} · {s.scopeType === 'workspace' ? 'Whole workspace' : `${s.scopeType}: ${scopeName(s.scopeType, s.scopeId)}`} · as {s.actingUser?.displayName ?? 'unknown user'}
                      {s.lastDelivery && <> · last delivery <span className={STATUS_CLS[s.lastDelivery.status]}>{s.lastDelivery.status}</span> {timeAgo(s.lastDelivery.createdAt)}</>}
                    </div>
                  </div>
                  <div className="flex items-center gap-1">
                    <Checkbox checked={s.enabled} onChange={(v) => patch.mutate({ id: s.id, body: { enabled: v } })} label={<span className="text-xs">Enabled</span>} className="mr-2" />
                    <Button size="sm" onClick={() => test.mutate(s)} loading={test.isPending && test.variables?.id === s.id}><Send className="size-3.5" />Send test</Button>
                    <Button size="sm" variant="ghost" onClick={() => setLogFor(logFor === s.id ? null : s.id)}>Deliveries</Button>
                    <IconButton size="sm" label="Edit" onClick={() => setEditing(s)}><Pencil className="size-3.5" /></IconButton>
                    <IconButton size="sm" label="Rotate signing secret" onClick={async () => { if (await dialogs.confirm({ title: 'Rotate signing secret?', body: 'The old secret stops working immediately; update the receiver with the new one.', confirm: 'Rotate' })) rotate.mutate(s); }}>
                      <RotateCw className="size-3.5" />
                    </IconButton>
                    <IconButton size="sm" label="Delete" onClick={async () => { if (await dialogs.confirm({ title: `Delete "${s.name}"?`, body: 'Its delivery log is deleted too.', confirm: 'Delete', danger: true })) del.mutate(s.id); }}>
                      <Trash2 className="size-3.5" />
                    </IconButton>
                  </div>
                </div>
                {logFor === s.id && <DeliveryLog subscriptionId={s.id} />}
              </div>
            ))}
          </div>
        )}
      </div>

      {editing && (
        <SubscriptionDialog
          sub={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onCreated={(name, value) => setSecret({ name, value })}
          onSaved={() => { setEditing(null); refresh(); }}
        />
      )}
      <Modal open={!!secret} onClose={() => setSecret(null)} title="Signing secret" width={560} footer={<Button variant="primary" onClick={() => setSecret(null)}>I've copied it</Button>}>
        <p className="mb-3 text-sm text-muted">This is the only time the signing secret for <b>{secret?.name}</b> is shown. Store it in the receiving system.</p>
        {secret && <CopyField value={secret.value} />}
      </Modal>
    </div>
  );
}

function useScopeName() {
  const { data: tree } = useTree();
  return (type: ScopeType, id: string | null) => {
    if (!tree || !id) return '—';
    for (const s of tree.spaces) {
      if (type === 'space' && s.id === id) return s.name;
      for (const f of s.folders) {
        if (type === 'folder' && f.id === id) return `${s.name} / ${f.name}`;
        const l = f.lists.find((x) => x.id === id);
        if (type === 'list' && l) return `${s.name} / ${f.name} / ${l.name}`;
      }
      const l = s.lists.find((x) => x.id === id);
      if (type === 'list' && l) return `${s.name} / ${l.name}`;
    }
    return 'unknown';
  };
}

function SubscriptionDialog({ sub, onClose, onSaved, onCreated }: { sub: Subscription | null; onClose: () => void; onSaved: () => void; onCreated: (name: string, secret: string) => void }) {
  const { data: users } = useUsers();
  const { data: me } = useMe();
  const [name, setName] = useState(sub?.name ?? '');
  const [url, setUrl] = useState(sub?.url ?? '');
  const [events, setEvents] = useState<string[]>(sub?.eventTypes ?? []);
  const [scopeType, setScopeType] = useState<ScopeType>(sub?.scopeType ?? 'workspace');
  const [scopeId, setScopeId] = useState(sub?.scopeId ?? '');
  const [actingUserId, setActingUserId] = useState(sub?.actingUserId ?? me?.user.id ?? '');
  const save = useMutation({
    mutationFn: async () => {
      const body = { name, url, eventTypes: events, scopeType, scopeId: scopeType === 'workspace' ? null : scopeId || null, actingUserId };
      if (sub) return api.patch(`/webhooks/subscriptions/${sub.id}`, body);
      const r = await api.post<{ secret: string }>('/webhooks/subscriptions', body);
      onCreated(name, r.secret);
      return r;
    },
    onSuccess: () => { toast.ok(sub ? 'Webhook saved' : 'Webhook created'); onSaved(); },
  });
  const toggle = (e: string) => setEvents((cur) => (cur.includes(e) ? cur.filter((x) => x !== e) : [...cur, e]));
  const people = (users ?? []).filter((u) => u.isActive);

  return (
    <Modal
      open
      onClose={onClose}
      title={sub ? 'Edit webhook' : 'Add webhook'}
      width={600}
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" loading={save.isPending} disabled={!name.trim() || !url.trim() || !actingUserId || (scopeType !== 'workspace' && !scopeId)} onClick={() => save.mutate()}>{sub ? 'Save' : 'Create'}</Button></>}
    >
      <div className="grid gap-4">
        <Field label="Name"><Input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Chat notifier" autoFocus /></Field>
        <Field label="Payload URL"><Input type="url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://example.internal/hooks/project" /></Field>
        <div>
          <div className="mb-1 text-xs font-medium text-muted">Events <span className="font-normal text-subtle">(none selected = all)</span></div>
          <div className="grid grid-cols-2 gap-1.5">
            {WEBHOOK_EVENT_TYPES.map((e) => <Checkbox key={e} checked={events.includes(e)} onChange={() => toggle(e)} label={<span className="font-mono text-xs">{e}</span>} />)}
          </div>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Scope">
            <Select value={scopeType} onChange={(e) => { setScopeType(e.target.value as ScopeType); setScopeId(''); }}>
              <option value="workspace">Whole workspace</option>
              <option value="space">A Space</option>
              <option value="folder">A Folder</option>
              <option value="list">A List</option>
            </Select>
          </Field>
          {scopeType !== 'workspace' && <Field label={`Which ${scopeType}`}><ScopeSelect type={scopeType} value={scopeId} onChange={setScopeId} /></Field>}
        </div>
        <Field label="Acting user" hint="payloads only include tasks this user can view">
          <Select value={actingUserId} onChange={(e) => setActingUserId(e.target.value)}>
            <option value="">Choose…</option>
            {people.map((u) => <option key={u.id} value={u.id}>{u.displayName}{u.isSystem ? ' (system)' : ` (${u.role})`}</option>)}
          </Select>
        </Field>
        {!sub && <p className="text-xs text-muted">A signing secret is generated when you create the webhook and shown once.</p>}
      </div>
    </Modal>
  );
}

function DeliveryLog({ subscriptionId }: { subscriptionId: string }) {
  const qc = useQueryClient();
  const [open, setOpen] = useState<string | null>(null);
  const { data } = useQuery({
    queryKey: ['webhook-deliveries', subscriptionId],
    queryFn: () => api.get<Delivery[]>(`/webhooks/subscriptions/${subscriptionId}/deliveries?limit=50`),
    refetchInterval: 10_000,
  });
  const retry = useMutation({
    mutationFn: (id: string) => api.post<Delivery>(`/webhooks/deliveries/${id}/retry`),
    onSuccess: (d) => {
      if (d.status === 'succeeded') toast.ok('Delivered');
      else toast.error(`Still failing${d.httpStatus ? ` (HTTP ${d.httpStatus})` : ''}`);
      void qc.invalidateQueries({ queryKey: ['webhook-deliveries', subscriptionId] });
      void qc.invalidateQueries({ queryKey: QK });
    },
  });
  if (!data) return <div className="border-t border-app"><Loading /></div>;
  if (!data.length) return <div className="border-t border-app p-3 text-sm text-muted">No deliveries yet.</div>;
  return (
    <div className="overflow-x-auto border-t border-app bg-subtle">
      <table className="w-full text-xs">
        <thead className="text-left text-muted">
          <tr><th className="px-3 py-1.5 font-medium">When</th><th className="font-medium">Event</th><th className="font-medium">Status</th><th className="font-medium">HTTP</th><th className="font-medium">Attempts</th><th className="font-medium">Response / next try</th><th /></tr>
        </thead>
        <tbody>
          {data.map((d) => (
            <Fragment key={d.id}>
              <tr className="cursor-pointer border-t border-app hover-bg" onClick={() => setOpen(open === d.id ? null : d.id)}>
                <td className="whitespace-nowrap px-3 py-1.5 text-muted">{new Date(d.createdAt).toLocaleString()}</td>
                <td className="font-mono">{d.eventType}</td>
                <td className={cx('font-medium', STATUS_CLS[d.status])}>{d.status}</td>
                <td>{d.httpStatus ?? '—'}</td>
                <td>{d.attempts}</td>
                <td className="max-w-xs truncate text-muted">{d.status === 'pending' && d.attempts > 0 ? `next try at ${new Date(d.nextAttemptAt).toLocaleTimeString()}` : d.responseExcerpt}</td>
                <td className="pr-3 text-right">
                  {d.status !== 'succeeded' && <Button size="sm" variant="ghost" onClick={(e) => { e.stopPropagation(); retry.mutate(d.id); }} loading={retry.isPending && retry.variables === d.id}>Retry</Button>}
                </td>
              </tr>
              {open === d.id && (
                <tr className="border-t border-app">
                  <td colSpan={7} className="px-3 py-2">
                    {d.responseExcerpt && <div className="mb-1 text-muted">Response: {d.responseExcerpt}</div>}
                    <pre className="max-h-64 overflow-auto rounded-md border border-app bg-app p-2 font-mono text-[11px]">{JSON.stringify(d.payload, null, 2)}</pre>
                  </td>
                </tr>
              )}
            </Fragment>
          ))}
        </tbody>
      </table>
    </div>
  );
}
