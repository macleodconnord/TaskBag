import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, ExternalLink, Pencil, Plus, RefreshCw, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { api, qs } from '@/lib/api';
import { timeAgo } from '@/lib/format';
import { useList } from '@/lib/queries';
import { toast } from '@/components/toast';
import { Badge, Button, Checkbox, Field, IconButton, Input, Loading, Modal, Select, useDialogs } from '@/components/ui';
import { Card, ListSelect, SyncLogTable, type SyncLog } from './common';

interface Mapping {
  id: string;
  name: string;
  boardIds: number[];
  targetListId: string;
  listName: string | null;
  filters: { orgIds?: number[]; statuses?: string[]; priorities?: string[]; formIds?: number[] };
  statusMap: Record<string, string>;
  fieldMap: Record<string, string>;
  syncComments: boolean;
  enabled: boolean;
  position: number;
}
interface NinjaState {
  enabled: boolean;
  configured: boolean;
  deltaBoardId: number | null;
  sourceBoardIds: number[];
  pollIntervalSec: number;
  state: { lastSuccessfulPollAt: string | null; lastReconcileAt: string | null; lastReconcileStatus: string | null; lastReconcileStats: Record<string, unknown> | null; reconcileRunning: boolean } | null;
  counts: { tickets: number; linked: number };
  logs: SyncLog[];
}
interface Meta {
  seen?: { statuses: string[]; priorities: string[]; orgIds: string[]; formIds: string[] };
  boards?: Array<{ id: number; name: string }>;
  statuses?: Array<Record<string, unknown>>;
  forms?: Array<Record<string, unknown>>;
  organizations?: Array<{ id: number; name: string }>;
  error?: string;
  errors?: string[];
}
interface Ticket { ticketId: number; subject: string | null; status: string | null; lastPolledAt: string; taskKey: string | null; url: string }

const nums = (s: string) => s.split(/[\s,]+/).map(Number).filter((n) => Number.isFinite(n) && n > 0);
const strs = (s: string) => s.split(',').map((x) => x.trim()).filter(Boolean);

/** NinjaOne extras on the integrations page: sync state, reconcile now, mapping rules, mirrored tickets. */
export function NinjaOnePanel() {
  const qc = useQueryClient();
  const state = useQuery({ queryKey: ['ninja-state'], queryFn: () => api.get<NinjaState>('/integrations/ninjaone/state'), refetchInterval: 10_000 });
  const mappings = useQuery({ queryKey: ['ninja-mappings'], queryFn: () => api.get<Mapping[]>('/integrations/ninjaone/mappings') });
  const tickets = useQuery({ queryKey: ['ninja-tickets'], queryFn: () => api.get<Ticket[]>('/integrations/ninjaone/tickets'), refetchInterval: 30_000 });
  const [editing, setEditing] = useState<Mapping | 'new' | null>(null);
  const dialogs = useDialogs();
  const refresh = () => {
    for (const k of ['ninja-state', 'ninja-mappings', 'ninja-tickets', 'integration-logs']) void qc.invalidateQueries({ queryKey: [k] });
  };
  const reconcile = useMutation({
    mutationFn: () => api.post('/integrations/ninjaone/reconcile'),
    onSuccess: () => { toast.ok('Reconcile started'); setTimeout(refresh, 1000); },
  });
  const poll = useMutation({
    mutationFn: () => api.post<{ ok: boolean; error?: string; result?: Record<string, unknown> }>('/integrations/ninjaone/poll'),
    onSuccess: (r) => { if (r.ok) toast.ok('Poll finished'); else toast.error(r.error ?? 'Poll failed'); refresh(); },
  });
  const del = useMutation({ mutationFn: (id: string) => api.delete(`/integrations/ninjaone/mappings/${id}`), onSuccess: refresh });
  const s = state.data;

  return (
    <>
      <Card
        title="Sync"
        action={
          <div className="flex gap-2">
            <Button size="sm" onClick={() => poll.mutate()} loading={poll.isPending} disabled={!s?.enabled || !s.deltaBoardId}>Poll now</Button>
            <Button size="sm" variant="primary" onClick={() => reconcile.mutate()} loading={reconcile.isPending} disabled={!s?.enabled || !s.sourceBoardIds.length || !!s.state?.reconcileRunning}>
              <RefreshCw className="size-3.5" />Reconcile now
            </Button>
          </div>
        }
      >
        {!s ? <Loading /> : (
          <div className="space-y-3">
            {!s.enabled && <p className="text-sm text-muted">Enable the integration to start polling. NinjaOne is only ever read, never written to.</p>}
            <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm sm:grid-cols-3">
              <Stat label="Delta board" value={s.deltaBoardId ?? '—'} />
              <Stat label="Source boards" value={s.sourceBoardIds.join(', ') || '—'} />
              <Stat label="Poll interval" value={`${s.pollIntervalSec}s`} />
              <Stat label="Last successful poll" value={s.state?.lastSuccessfulPollAt ? timeAgo(s.state.lastSuccessfulPollAt) : 'never'} />
              <Stat
                label="Last reconcile"
                value={s.state?.reconcileRunning
                  ? <span className="inline-flex items-center gap-1 text-accent-600"><RefreshCw className="size-3 animate-spin" />running…</span>
                  : s.state?.lastReconcileAt ? `${timeAgo(s.state.lastReconcileAt)} (${s.state.lastReconcileStatus})` : 'never'}
              />
              <Stat label="Tickets mirrored" value={`${s.counts.tickets} (${s.counts.linked} linked to tasks)`} />
            </dl>
            <SyncLogTable logs={s.logs.slice(0, 8)} />
          </div>
        )}
      </Card>

      <Card title="Ticket → task mapping rules" action={<Button size="sm" onClick={() => setEditing('new')}><Plus className="size-3.5" />Add rule</Button>}>
        <p className="mb-3 text-xs text-muted">
          A new ticket becomes a task in the first enabled rule (top to bottom) whose filters it matches. Changed tickets update their linked task: title, priority,
          status (only when the ticket's status actually changes), mapped fields and public comments. The delta board's filters must cover every org, status and form used here.
        </p>
        {!mappings.data ? <Loading /> : !mappings.data.length ? (
          <div className="rounded-md border border-dashed border-app p-3 text-sm text-muted">No rules yet — tickets are mirrored but no tasks are created.</div>
        ) : (
          <div className="divide-y divide-[var(--border)] rounded-md border border-app">
            {mappings.data.map((m) => (
              <div key={m.id} className="flex items-start gap-3 px-3 py-2.5">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">{m.name}</span>
                    {!m.enabled && <Badge>Disabled</Badge>}
                    <span className="text-xs text-muted">→ {m.listName ?? 'missing list'}</span>
                  </div>
                  <div className="mt-0.5 text-xs text-muted">{describeFilters(m)}</div>
                </div>
                <IconButton size="sm" label="Edit rule" onClick={() => setEditing(m)}><Pencil className="size-3.5" /></IconButton>
                <IconButton size="sm" label="Delete rule" onClick={async () => { if (await dialogs.confirm({ title: `Delete rule "${m.name}"?`, body: 'Existing tasks stay linked to their tickets.', confirm: 'Delete', danger: true })) del.mutate(m.id); }}>
                  <Trash2 className="size-3.5" />
                </IconButton>
              </div>
            ))}
          </div>
        )}
      </Card>

      <Card title="Recently synced tickets">
        {!tickets.data ? <Loading /> : !tickets.data.length ? <div className="text-sm text-muted">No tickets yet.</div> : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="text-left text-muted"><tr><th className="py-1 font-medium">Ticket</th><th className="font-medium">Subject</th><th className="font-medium">Status</th><th className="font-medium">Task</th><th className="font-medium">Seen</th></tr></thead>
              <tbody>
                {tickets.data.slice(0, 20).map((t) => (
                  <tr key={t.ticketId} className="border-t border-app">
                    <td className="py-1.5"><a href={t.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-accent-600 hover:underline">#{t.ticketId}<ExternalLink className="size-3" /></a></td>
                    <td className="max-w-xs truncate">{t.subject}</td>
                    <td>{t.status}</td>
                    <td>{t.taskKey ? <a className="text-accent-600 hover:underline" href={`/t/${t.taskKey}`}>{t.taskKey}</a> : <span className="text-subtle">unmapped</span>}</td>
                    <td className="whitespace-nowrap text-muted">{timeAgo(t.lastPolledAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {editing && <MappingDialog mapping={editing === 'new' ? null : editing} position={mappings.data?.length ?? 0} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); refresh(); }} />}
    </>
  );
}

function Stat({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div>
      <dt className="text-xs text-muted">{label}</dt>
      <dd className="font-medium">{value}</dd>
    </div>
  );
}

function describeFilters(m: Mapping) {
  const parts: string[] = [];
  if (m.boardIds.length) parts.push(`boards ${m.boardIds.join(', ')}`);
  if (m.filters.orgIds?.length) parts.push(`orgs ${m.filters.orgIds.join(', ')}`);
  if (m.filters.statuses?.length) parts.push(`status ${m.filters.statuses.join(', ')}`);
  if (m.filters.priorities?.length) parts.push(`priority ${m.filters.priorities.join(', ')}`);
  if (m.filters.formIds?.length) parts.push(`forms ${m.filters.formIds.join(', ')}`);
  const sm = Object.keys(m.statusMap).length;
  const fm = Object.keys(m.fieldMap).length;
  return `${parts.length ? parts.join(' · ') : 'all tickets'} · ${sm} status mapping${sm === 1 ? '' : 's'} · ${fm} field${fm === 1 ? '' : 's'}${m.syncComments ? ' · comments' : ''}`;
}

interface Row { k: string; v: string }
const toRows = (o: Record<string, string>): Row[] => [...Object.entries(o).map(([k, v]) => ({ k, v })), { k: '', v: '' }];
const fromRows = (rows: Row[]) => Object.fromEntries(rows.filter((r) => r.k.trim() && r.v).map((r) => [r.k.trim(), r.v]));

function MappingDialog({ mapping, position, onClose, onSaved }: { mapping: Mapping | null; position: number; onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState(mapping?.name ?? '');
  const [listId, setListId] = useState(mapping?.targetListId ?? '');
  const [boards, setBoards] = useState(mapping?.boardIds.join(', ') ?? '');
  const [orgs, setOrgs] = useState(mapping?.filters.orgIds?.join(', ') ?? '');
  const [statuses, setStatuses] = useState(mapping?.filters.statuses?.join(', ') ?? '');
  const [priorities, setPriorities] = useState(mapping?.filters.priorities?.join(', ') ?? '');
  const [forms, setForms] = useState(mapping?.filters.formIds?.join(', ') ?? '');
  const [statusRows, setStatusRows] = useState<Row[]>(toRows(mapping?.statusMap ?? {}));
  const [fieldRows, setFieldRows] = useState<Row[]>(toRows(mapping?.fieldMap ?? {}));
  const [syncComments, setSyncComments] = useState(mapping?.syncComments ?? true);
  const [enabled, setEnabled] = useState(mapping?.enabled ?? true);
  const list = useList(listId || undefined);
  const meta = useQuery({ queryKey: ['ninja-meta'], queryFn: () => api.get<Meta>('/integrations/ninjaone/meta'), staleTime: 5 * 60_000 });
  const fields = useQuery({
    queryKey: ['fields', 'list', listId],
    queryFn: () => api.get<Array<{ id: string; name: string; type: string }>>(`/fields${qs({ scopeType: 'list', scopeId: listId })}`),
    enabled: !!listId,
  });

  const save = useMutation({
    mutationFn: () => {
      const body = {
        name, targetListId: listId, boardIds: nums(boards),
        filters: { orgIds: nums(orgs), statuses: strs(statuses), priorities: strs(priorities), formIds: nums(forms) },
        statusMap: fromRows(statusRows), fieldMap: fromRows(fieldRows), syncComments, enabled,
        ...(mapping ? {} : { position }),
      };
      return mapping ? api.patch(`/integrations/ninjaone/mappings/${mapping.id}`, body) : api.post('/integrations/ninjaone/mappings', body);
    },
    onSuccess: () => { toast.ok('Rule saved'); onSaved(); },
  });

  // coverage warning: filter values not seen on synced tickets in the last 7 days
  const seen = meta.data?.seen;
  const unseen = seen ? [
    ...strs(statuses).filter((v) => !seen.statuses.includes(v.toLowerCase())).map((v) => `status "${v}"`),
    ...strs(priorities).filter((v) => !seen.priorities.includes(v.toLowerCase())).map((v) => `priority "${v}"`),
    ...nums(orgs).filter((v) => !seen.orgIds.includes(String(v))).map((v) => `org ${v}`),
    ...nums(forms).filter((v) => !seen.formIds.includes(String(v))).map((v) => `form ${v}`),
  ] : [];
  const ninjaStatuses = (meta.data?.statuses ?? []).map((st) => String(st.displayName ?? st.name ?? '')).filter(Boolean);

  const kvEditor = (rows: Row[], set: (r: Row[]) => void, left: { placeholder: string; options?: string[] }, right: React.ReactNode | ((r: Row, i: number) => React.ReactNode)) => (
    <div className="space-y-1.5">
      {rows.map((r, i) => (
        <div key={i} className="flex items-center gap-2">
          <Input
            className="h-7 flex-1 text-xs"
            list={left.options ? `opts-${left.placeholder}` : undefined}
            placeholder={left.placeholder}
            value={r.k}
            onChange={(e) => {
              const next = rows.map((x, j) => (j === i ? { ...x, k: e.target.value } : x));
              if (i === rows.length - 1 && e.target.value) next.push({ k: '', v: '' });
              set(next);
            }}
          />
          <span className="text-subtle">→</span>
          <div className="flex-1">{typeof right === 'function' ? right(r, i) : right}</div>
        </div>
      ))}
      {left.options && <datalist id={`opts-${left.placeholder}`}>{left.options.map((o) => <option key={o} value={o} />)}</datalist>}
    </div>
  );
  const setRow = (rows: Row[], set: (r: Row[]) => void, i: number, v: string) => set(rows.map((x, j) => (j === i ? { ...x, v } : x)));

  return (
    <Modal
      open
      onClose={onClose}
      title={mapping ? 'Edit mapping rule' : 'New mapping rule'}
      width={680}
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" loading={save.isPending} disabled={!name.trim() || !listId} onClick={() => save.mutate()}>Save rule</Button></>}
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Name"><Input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Helpdesk → Support list" autoFocus /></Field>
        <Field label="Create tasks in"><ListSelect value={listId} onChange={setListId} /></Field>
        <Field label="Boards" hint="IDs, empty = any polled board">
          <Input value={boards} onChange={(e) => setBoards(e.target.value)} placeholder="e.g. 12, 14" />
        </Field>
        <Field label="Organizations" hint="IDs, empty = all"><Input value={orgs} onChange={(e) => setOrgs(e.target.value)} /></Field>
        <Field label="Statuses" hint="names, comma separated"><Input value={statuses} onChange={(e) => setStatuses(e.target.value)} placeholder="e.g. Open, In Progress" /></Field>
        <Field label="Priorities" hint="e.g. HIGH, URGENT"><Input value={priorities} onChange={(e) => setPriorities(e.target.value)} /></Field>
        <Field label="Ticket forms" hint="IDs"><Input value={forms} onChange={(e) => setForms(e.target.value)} /></Field>
        <div className="flex flex-col justify-end gap-2">
          <Checkbox checked={syncComments} onChange={setSyncComments} label="Sync public comments" />
          <Checkbox checked={enabled} onChange={setEnabled} label="Rule enabled" />
        </div>
      </div>

      {(meta.data?.boards || meta.data?.organizations) && (
        <details className="mt-3 text-xs text-muted">
          <summary className="cursor-pointer">Lookup: boards, organizations and forms from NinjaOne</summary>
          <div className="mt-2 grid gap-2 sm:grid-cols-3">
            <div><b>Boards</b>{meta.data.boards?.map((b) => <div key={b.id}>{b.id} — {b.name}</div>)}</div>
            <div><b>Organizations</b>{meta.data.organizations?.slice(0, 50).map((o) => <div key={o.id}>{o.id} — {o.name}</div>)}</div>
            <div><b>Forms</b>{meta.data.forms?.map((f) => <div key={String(f.id)}>{String(f.id)} — {String(f.name)}</div>)}</div>
          </div>
        </details>
      )}
      {meta.data?.error && <p className="mt-3 text-xs text-muted">NinjaOne lookups unavailable: {meta.data.error}</p>}
      {unseen.length > 0 && (
        <div className="mt-3 flex items-start gap-2 rounded-md border border-amber-300 bg-amber-50 p-2 text-xs text-amber-800 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-300">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
          <span>Not seen on any synced ticket in the last 7 days: {unseen.join(', ')}. Check the spelling and that the delta board's filters include it.</span>
        </div>
      )}

      <div className="mt-5">
        <h4 className="mb-1 text-sm font-semibold">Status mapping</h4>
        <p className="mb-2 text-xs text-muted">When a ticket's status changes to the NinjaOne status on the left, the task moves to the status on the right.</p>
        {!listId ? <p className="text-xs text-subtle">Choose a List first.</p> : kvEditor(statusRows, setStatusRows, { placeholder: 'NinjaOne status', options: ninjaStatuses }, (r, i) => (
          <Select className="h-7 text-xs" value={r.v} onChange={(e) => setRow(statusRows, setStatusRows, i, e.target.value)}>
            <option value="">—</option>
            {list.data?.statuses.map((st) => <option key={st.id} value={st.id}>{st.name}</option>)}
          </Select>
        ))}
      </div>

      <div className="mt-5">
        <h4 className="mb-1 text-sm font-semibold">Field mapping</h4>
        <p className="mb-2 text-xs text-muted">Ticket field path (e.g. <code>severity</code>, <code>requester.name</code>, <code>attribute:12</code>) → custom field on the List.</p>
        {!listId ? <p className="text-xs text-subtle">Choose a List first.</p> : kvEditor(fieldRows, setFieldRows, { placeholder: 'ticket field path' }, (r, i) => (
          <Select className="h-7 text-xs" value={r.v} onChange={(e) => setRow(fieldRows, setFieldRows, i, e.target.value)}>
            <option value="">—</option>
            {fields.data?.map((f) => <option key={f.id} value={f.id}>{f.name} ({f.type})</option>)}
          </Select>
        ))}
      </div>
    </Modal>
  );
}
