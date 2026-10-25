import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AlertTriangle, CheckCircle2, CircleDashed, Download, FileJson, FileSpreadsheet, Import, Info, Loader2, Pause, Play, RefreshCw, ShieldCheck, Square, XCircle,
} from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router';
import { api, qs } from '@/lib/api';
import { fileSize, timeAgo } from '@/lib/format';
import { useMe, useUsers } from '@/lib/queries';
import { toast } from '@/components/toast';
import { Badge, Button, Checkbox, cx, Empty, Field, Input, Loading, PageHeader, Select, Tabs, useDialogs } from '@/components/ui';

// ───────────── API shapes (apps/server/src/modules/import) ─────────────

type Mode = 'dry_run' | 'full' | 'delta';
type RunStatus = 'queued' | 'running' | 'paused' | 'cancelled' | 'succeeded' | 'failed';
type Counts = Record<string, number>;
interface RunOptions { includeArchived: boolean; includeActivity: boolean; downloadAttachments: boolean; includeDocs: boolean; includeViews: boolean; includePermissions: boolean }
interface Validation {
  at: string;
  ok: boolean;
  lists: Array<{ listExt: string; name: string; clickup: number; ours: number; ok: boolean }>;
  fields: { checked: number; mismatches: Array<{ task: string; field: string; expected: unknown; actual: unknown }> };
  attachments: { checked: number; mismatches: Array<{ attachment: string; filename: string; problem: string }> };
}
interface Run {
  id: string;
  mode: Mode;
  status: RunStatus;
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
  since: string | null;
  error: string | null;
  stats: Record<string, Counts>;
  stage: string | null;
  stages: Array<{ key: string; label: string; done: boolean }>;
  progress: { stage: string | null; done: number; total: number; label?: string } | null;
  awaitingUserMapping: boolean;
  options: RunOptions | null;
  validation: Validation | null;
  client: { requests: number; remaining: number | null; limit: number | null; throttledMs: number; retries: number } | null;
  workspaceName: string | null;
  executingHere: boolean;
  issueCounts: Partial<Record<'info' | 'warn' | 'error', number>>;
}
interface Status {
  credentials: { configured: boolean; source: 'settings' | 'env' | null; enabled: boolean; teamId: string | null };
  openRun: Run | null;
  executing: string | null;
  lockFree: boolean;
  defaultSince: string | null;
}
interface Mapping {
  clickupUserId: string;
  clickupEmail: string | null;
  clickupName: string | null;
  userId: string | null;
  resolution: 'auto_email' | 'manual' | 'placeholder' | 'skip' | 'unresolved';
  user: { id: string; displayName: string; email: string; isPlaceholder: boolean } | null;
}
interface Issue { id: string; severity: 'info' | 'warn' | 'error'; entity: string; externalId: string | null; message: string; createdAt: string }

const QK = {
  status: ['import', 'status'] as const,
  runs: ['import', 'runs'] as const,
  run: (id: string) => ['import', 'run', id] as const,
  users: ['import', 'users'] as const,
  issues: (id: string, sev: string) => ['import', 'issues', id, sev] as const,
};

const MODE_LABEL: Record<Mode, string> = { dry_run: 'Dry run', full: 'Full import', delta: 'Delta import' };
const STATUS_TONE: Record<RunStatus, string> = {
  queued: '#64748b', running: '#2563eb', paused: '#d97706', cancelled: '#64748b', succeeded: '#16a34a', failed: '#dc2626',
};
const isOpen = (s: RunStatus) => s === 'queued' || s === 'running' || s === 'paused';
const fmt = (iso: string | null) => (iso ? new Date(iso).toLocaleString() : '—');

function duration(a: string | null, b: string | null) {
  if (!a) return '';
  const ms = (b ? new Date(b).getTime() : Date.now()) - new Date(a).getTime();
  const m = Math.floor(ms / 60_000);
  return m >= 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : m >= 1 ? `${m} min` : `${Math.max(1, Math.round(ms / 1000))} s`;
}

function Card({ title, icon, actions, children, className }: { title: ReactNode; icon?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={cx('rounded-lg border border-app bg-app', className)}>
      <header className="flex min-h-11 flex-wrap items-center gap-2 border-b border-app px-4 py-2">
        {icon}
        <h2 className="flex-1 text-sm font-semibold">{title}</h2>
        {actions}
      </header>
      <div className="p-4">{children}</div>
    </section>
  );
}

const StatusBadge = ({ status }: { status: RunStatus }) => <Badge color={STATUS_TONE[status]}>{status === 'running' && <Loader2 className="size-3 animate-spin" />}{status}</Badge>;

// ───────────── page ─────────────

export function AdminImportPage() {
  const { data: me } = useMe();
  const isAdmin = me && (me.user.role === 'owner' || me.user.role === 'admin');
  const [params, setParams] = useSearchParams();
  const tab = (['users', 'history'].includes(params.get('tab') ?? '') ? params.get('tab') : 'run') as 'run' | 'users' | 'history';
  const setTab = (t: 'run' | 'users' | 'history') => setParams(t === 'run' ? {} : { tab: t }, { replace: true });
  const selected = params.get('run');
  const setSelected = (id: string | null) => setParams(id ? { tab: 'history', run: id } : { tab: 'history' }, { replace: true });
  const status = useQuery({
    queryKey: QK.status,
    queryFn: () => api.get<Status>('/import/status'),
    enabled: !!isAdmin,
    refetchInterval: (q) => (q.state.data?.openRun?.status === 'running' || q.state.data?.openRun?.status === 'queued' ? 2000 : 15_000),
  });
  if (me && !isAdmin) return <Empty title="Admins only" />;
  const open = status.data?.openRun ?? null;

  return (
    <div className="flex h-full flex-col">
      <PageHeader title="ClickUp import" icon={<Import className="size-5 text-muted" />}>
        <Tabs
          value={tab}
          onChange={setTab}
          items={[
            { value: 'run', label: 'Import' },
            { value: 'users', label: <span className="inline-flex items-center gap-1.5">User mapping{open?.awaitingUserMapping && <span className="size-2 rounded-full bg-amber-500" />}</span> },
            { value: 'history', label: 'Runs & reports' },
          ]}
        />
      </PageHeader>
      <div className="min-h-0 flex-1 overflow-y-auto p-5">
        {status.isError && !status.data ? (
          <Empty icon={<XCircle className="size-6" />} title="Could not load the importer status">
            {(status.error as Error)?.message} <Button size="sm" className="mt-2" onClick={() => void status.refetch()}>Retry</Button>
          </Empty>
        ) : !status.data ? <Loading /> : (
          <div className="mx-auto max-w-5xl space-y-5">
            {tab === 'run' && (
              <>
                <ConnectionCard status={status.data} />
                {open ? <RunPanel run={open} orphan={(open.status === 'running' || open.status === 'queued') && status.data.lockFree} onUsers={() => setTab('users')} /> : <StartCard status={status.data} />}
                {open && <RunDetails run={open} />}
              </>
            )}
            {tab === 'users' && <UserMapping awaiting={!!open?.awaitingUserMapping} runId={open?.id ?? null} />}
            {tab === 'history' && <History selected={selected} onSelect={setSelected} />}
          </div>
        )}
      </div>
    </div>
  );
}

// ───────────── connection ─────────────

function ConnectionCard({ status }: { status: Status }) {
  const c = status.credentials;
  const [test, setTest] = useState<{ ok: boolean; workspace?: string; members?: number; error?: string; rateLimit?: { remaining: number | null; limit: number | null } } | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <Card
      title="ClickUp connection"
      icon={c.configured ? <CheckCircle2 className="size-4 text-emerald-600 dark:text-emerald-400" /> : <AlertTriangle className="size-4 text-amber-600 dark:text-amber-400" />}
      actions={c.configured && (
        <Button size="sm" loading={busy} onClick={async () => {
          setBusy(true);
          try { setTest(await api.post('/import/test')); } finally { setBusy(false); }
        }}>Test connection</Button>
      )}
    >
      {c.configured ? (
        <div className="space-y-2 text-sm">
          <p className="text-muted">
            Workspace ID <span className="font-mono text-app">{c.teamId}</span> · token from {c.source === 'env' ? 'environment variables' : <Link className="text-accent-600 hover:underline dark:text-accent-400" to="/admin/integrations?i=clickup">Integrations & credentials</Link>}.
            The importer stays under ~90 requests/minute so people still using ClickUp aren't throttled.
          </p>
          {test && (test.ok ? (
            <p className="text-emerald-700 dark:text-emerald-400">Connected to “{test.workspace}” ({test.members} members){test.rateLimit?.limit ? ` · rate limit ${test.rateLimit.remaining}/${test.rateLimit.limit} left this minute` : ''}.</p>
          ) : <p className="text-red-600 dark:text-red-400">{test.error}</p>)}
        </div>
      ) : (
        <p className="text-sm text-muted">
          ClickUp isn't configured yet. Add the API token and workspace (team) ID under{' '}
          <Link className="font-medium text-accent-600 hover:underline dark:text-accent-400" to="/admin/integrations?i=clickup">Admin → Integrations & credentials</Link>.
        </p>
      )}
    </Card>
  );
}

// ───────────── start ─────────────

const OPTION_LABELS: Array<[keyof RunOptions, string, string]> = [
  ['includeArchived', 'Archived spaces, lists and tasks', ''],
  ['includeActivity', 'Comments and attachments', 'about 2 API calls per task'],
  ['downloadAttachments', 'Download attachment files', 'off: count only'],
  ['includeDocs', 'Docs', ''],
  ['includeViews', 'Views', ''],
  ['includePermissions', 'Private spaces/folders/lists (sharing)', ''],
];

function StartCard({ status }: { status: Status }) {
  const qc = useQueryClient();
  const { confirm } = useDialogs();
  const [opts, setOpts] = useState<RunOptions>({ includeArchived: true, includeActivity: true, downloadAttachments: true, includeDocs: true, includeViews: true, includePermissions: true });
  const [since, setSince] = useState('');
  const [busy, setBusy] = useState<Mode | null>(null);
  const start = async (mode: Mode) => {
    if (mode === 'full' && !(await confirm({ title: 'Start a full import?', body: 'Spaces, lists, tasks, comments, files, docs and views are created or updated here. Re-running is safe: existing items are matched and updated, not duplicated.', confirm: 'Start import' }))) return;
    setBusy(mode);
    try {
      await api.post('/import/runs', { mode, options: opts, since: mode === 'delta' && since ? new Date(since).toISOString() : undefined });
      toast.ok(`${MODE_LABEL[mode]} started`);
      void qc.invalidateQueries({ queryKey: ['import'] });
    } finally {
      setBusy(null);
    }
  };
  const disabled = !status.credentials.configured || !status.lockFree;
  return (
    <Card title="Start an import" icon={<Play className="size-4 text-muted" />}>
      <div className="grid gap-5 md:grid-cols-[1fr_auto]">
        <div className="space-y-3">
          <div className="grid gap-x-6 gap-y-2 sm:grid-cols-2">
            {OPTION_LABELS.map(([k, label, hint]) => (
              <Checkbox key={k} checked={opts[k]} onChange={(v) => setOpts((o) => ({ ...o, [k]: v }))}
                disabled={k === 'downloadAttachments' && !opts.includeActivity}
                label={<span>{label}{hint && <span className="ml-1 text-xs text-subtle">({hint})</span>}</span>} />
            ))}
          </div>
          <Field label="Delta: changes since" hint={status.defaultSince ? `(default: ${fmt(status.defaultSince)}, from the last successful import)` : '(no successful import yet)'} className="max-w-sm">
            <Input type="datetime-local" value={since} onChange={(e) => setSince(e.target.value)} />
          </Field>
          {!status.lockFree && <p className="text-sm text-amber-700 dark:text-amber-400">Another process is running an import right now.</p>}
        </div>
        <div className="flex flex-col gap-2 md:w-56">
          <Button loading={busy === 'dry_run'} disabled={disabled} onClick={() => start('dry_run')}><CircleDashed className="size-4" />Dry run</Button>
          <p className="-mt-1 text-xs text-muted">Reads everything and reports what would change. Nothing is written.</p>
          <Button variant="primary" loading={busy === 'full'} disabled={disabled} onClick={() => start('full')}><Download className="size-4" />Full import</Button>
          <Button loading={busy === 'delta'} disabled={disabled || (!status.defaultSince && !since)} onClick={() => start('delta')}><RefreshCw className="size-4" />Delta import</Button>
          <p className="-mt-1 text-xs text-muted">Only tasks changed in ClickUp since the date above.</p>
        </div>
      </div>
    </Card>
  );
}

// ───────────── live run ─────────────

function RunPanel({ run, orphan, onUsers }: { run: Run; orphan: boolean; onUsers: () => void }) {
  const qc = useQueryClient();
  const { confirm } = useDialogs();
  const [busy, setBusy] = useState<string | null>(null);
  const act = async (action: 'pause' | 'resume' | 'cancel') => {
    if (action === 'cancel' && !(await confirm({ title: 'Cancel this import?', body: 'What was imported so far stays. You can start a new run later; it continues where items already exist.', confirm: 'Cancel import', danger: true }))) return;
    setBusy(action);
    try {
      await api.post(`/import/runs/${run.id}/${action}`);
      void qc.invalidateQueries({ queryKey: ['import'] });
    } finally {
      setBusy(null);
    }
  };
  const p = run.progress;
  const pct = p && p.total ? Math.min(100, Math.round((p.done / p.total) * 100)) : null;
  return (
    <Card
      title={<span className="inline-flex flex-wrap items-center gap-2">{MODE_LABEL[run.mode]} <StatusBadge status={run.status} />{run.workspaceName && <span className="font-normal text-muted">· {run.workspaceName}</span>}</span>}
      actions={(
        <div className="flex gap-2">
          {run.status === 'running' && !orphan && <Button size="sm" loading={busy === 'pause'} onClick={() => act('pause')}><Pause className="size-3.5" />Pause</Button>}
          {(run.status === 'paused' || orphan) && (
            <Button size="sm" variant="primary" loading={busy === 'resume'} onClick={() => act('resume')}><Play className="size-3.5" />Resume</Button>
          )}
          <Button size="sm" variant="ghost" loading={busy === 'cancel'} onClick={() => act('cancel')}><Square className="size-3.5" />Cancel</Button>
        </div>
      )}
    >
      {run.awaitingUserMapping && (
        <div className="mb-4 flex flex-wrap items-center gap-3 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-200">
          <AlertTriangle className="size-4 shrink-0" />
          <span className="flex-1">Some ClickUp users have no matching account. Map them, create placeholders or skip them, then resume.</span>
          <Button size="sm" onClick={onUsers}>Review users</Button>
        </div>
      )}
      <ol className="space-y-1.5">
        {run.stages.map((s) => {
          const current = run.stage === s.key && !s.done;
          return (
            <li key={s.key} className="flex items-center gap-2.5 text-sm">
              {s.done ? <CheckCircle2 className="size-4 shrink-0 text-emerald-600 dark:text-emerald-400" />
                : current ? (run.status === 'running' ? <Loader2 className="size-4 shrink-0 animate-spin text-accent-600 dark:text-accent-400" /> : <Pause className="size-4 shrink-0 text-amber-600" />)
                : <CircleDashed className="size-4 shrink-0 text-subtle" />}
              <span className={cx('w-64 shrink-0', s.done ? 'text-muted' : current ? 'font-medium' : 'text-subtle')}>{s.label}</span>
              {current && (
                <span className="flex min-w-0 flex-1 items-center gap-2">
                  {pct !== null && (
                    <span className="h-1.5 w-32 shrink-0 overflow-hidden rounded-full bg-muted">
                      <span className="block h-full rounded-full bg-accent-600 transition-all" style={{ width: `${pct}%` }} />
                    </span>
                  )}
                  <span className="truncate text-xs text-muted">{p?.total ? `${p.done}/${p.total}` : ''} {p?.label}</span>
                </span>
              )}
            </li>
          );
        })}
      </ol>
      <div className="mt-4 flex flex-wrap gap-x-5 gap-y-1 text-xs text-muted">
        <span>Started {fmt(run.startedAt)} {run.startedAt && run.status === 'running' && `(${duration(run.startedAt, null)})`}</span>
        {run.since && <span>Changes since {fmt(run.since)}</span>}
        {run.client && <span>{run.client.requests} API calls{run.client.remaining !== null ? ` · ${run.client.remaining} left this minute` : ''}{run.client.retries ? ` · ${run.client.retries} retries` : ''}{run.client.throttledMs > 1000 ? ` · throttled ${Math.round(run.client.throttledMs / 1000)} s` : ''}</span>}
        {orphan ? <span className="text-amber-700 dark:text-amber-400">Not executing (the process stopped) — resume to continue from the checkpoint</span>
          : run.status === 'running' && !run.executingHere && <span>Executing in another process</span>}
      </div>
      {run.error && <p className="mt-3 text-sm text-red-600 dark:text-red-400">{run.error}</p>}
    </Card>
  );
}

// ───────────── run details: counts, issues, validation, report ─────────────

const STAT_COLS = ['seen', 'created', 'updated', 'unchanged', 'skipped', 'failed'] as const;
const ENTITY_LABEL: Record<string, string> = {
  user: 'Users', group: 'Groups', space: 'Spaces', folder: 'Folders', list: 'Lists', status: 'Statuses', field: 'Custom fields', tag: 'Tags',
  task: 'Tasks', checklist: 'Checklists', checklist_item: 'Checklist items', field_value: 'Field values', subtask_parent: 'Subtask parents',
  dependency: 'Dependencies', link: 'Links', comment: 'Comments', attachment: 'Attachments', attachment_bytes: 'Attachment data', doc: 'Docs',
  view: 'Views', sharing: 'Private locations',
};

function StatsTable({ run }: { run: Run }) {
  const order = Object.keys(ENTITY_LABEL);
  const rank = (k: string) => (order.indexOf(k) < 0 ? 999 : order.indexOf(k));
  const rows = Object.entries(run.stats ?? {}).sort(([a], [b]) => rank(a) - rank(b));
  if (!rows.length) return <p className="text-sm text-muted">No counts yet.</p>;
  const cell = (entity: string, v: number | undefined) => (entity === 'attachment_bytes' ? (v ? fileSize(v) : '') : v || '');
  return (
    <div className="overflow-x-auto rounded-md border border-app">
      <table className="w-full text-sm">
        <thead className="bg-subtle text-left text-xs text-muted">
          <tr>
            <th className="px-3 py-1.5 font-medium">Entity</th>
            {STAT_COLS.map((c) => <th key={c} className="px-3 text-right font-medium">{run.mode === 'dry_run' && c === 'created' ? 'would create' : run.mode === 'dry_run' && c === 'updated' ? 'would update' : c}</th>)}
          </tr>
        </thead>
        <tbody>
          {rows.map(([entity, c]) => (
            <tr key={entity} className="border-t border-app">
              <td className="px-3 py-1.5">{ENTITY_LABEL[entity] ?? entity}</td>
              {STAT_COLS.map((k) => (
                <td key={k} className={cx('px-3 text-right tabular-nums', k === 'failed' && c[k] ? 'font-medium text-red-600 dark:text-red-400' : k === 'created' && c[k] ? 'text-app' : 'text-muted')}>{cell(entity, c[k])}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const SEV_ICON = {
  error: <XCircle className="size-4 text-red-600 dark:text-red-400" />,
  warn: <AlertTriangle className="size-4 text-amber-600 dark:text-amber-400" />,
  info: <Info className="size-4 text-sky-600 dark:text-sky-400" />,
};

function IssuesTable({ run }: { run: Run }) {
  const [sev, setSev] = useState<'' | 'error' | 'warn' | 'info'>('');
  const [limit, setLimit] = useState(100);
  const { data } = useQuery({
    queryKey: [...QK.issues(run.id, sev), limit],
    queryFn: () => api.get<{ total: number; items: Issue[] }>(`/import/runs/${run.id}/issues${qs({ severity: sev, limit })}`),
    refetchInterval: isOpen(run.status) ? 5000 : false,
  });
  const c = run.issueCounts;
  return (
    <div>
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <Select className="w-44" value={sev} onChange={(e) => setSev(e.target.value as typeof sev)}>
          <option value="">All issues ({(c.error ?? 0) + (c.warn ?? 0) + (c.info ?? 0)})</option>
          <option value="error">Errors ({c.error ?? 0})</option>
          <option value="warn">Warnings ({c.warn ?? 0})</option>
          <option value="info">Info ({c.info ?? 0})</option>
        </Select>
        <span className="text-xs text-muted">Warnings are lossy mappings or skipped items; info lists features that aren't imported.</span>
      </div>
      {!data ? <Loading /> : !data.items.length ? <p className="rounded-md border border-dashed border-app p-3 text-sm text-muted">No issues.</p> : (
        <div className="max-h-[28rem] overflow-auto rounded-md border border-app">
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-subtle text-left text-xs text-muted">
              <tr>
                <th className="w-8 px-2 py-1.5" />
                <th className="px-2 font-medium">Entity</th>
                <th className="px-2 font-medium">ClickUp ID</th>
                <th className="px-2 font-medium">Message</th>
              </tr>
            </thead>
            <tbody>
              {data.items.map((i) => (
                <tr key={i.id} className="border-t border-app align-top">
                  <td className="px-2 py-1.5">{SEV_ICON[i.severity]}</td>
                  <td className="whitespace-nowrap px-2 py-1.5 text-muted">{i.entity}</td>
                  <td className="max-w-40 truncate px-2 py-1.5 font-mono text-xs text-muted" title={i.externalId ?? ''}>{i.externalId}</td>
                  <td className="px-2 py-1.5">{i.message}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {data.total > data.items.length && (
            <div className="border-t border-app p-2 text-center">
              <Button size="sm" variant="ghost" onClick={() => setLimit((l) => Math.min(500, l + 200))} disabled={limit >= 500}>
                Show more ({data.total - data.items.length} more{limit >= 500 ? ' — download the report for all' : ''})
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function ValidationView({ run }: { run: Run }) {
  const qc = useQueryClient();
  const v = run.validation;
  const [busy, setBusy] = useState(false);
  const revalidate = async () => {
    setBusy(true);
    try {
      await api.post(`/import/runs/${run.id}/validate`);
      toast.ok('Validation started; results appear here when it finishes');
      setTimeout(() => void qc.invalidateQueries({ queryKey: ['import'] }), 3000);
    } finally {
      setBusy(false);
    }
  };
  const mismatchedLists = v?.lists.filter((l) => !l.ok) ?? [];
  return (
    <div className="space-y-3 text-sm">
      <div className="flex flex-wrap items-center gap-3">
        {v ? (v.ok
          ? <span className="inline-flex items-center gap-1.5 font-medium text-emerald-700 dark:text-emerald-400"><ShieldCheck className="size-4" />Everything matches ClickUp</span>
          : <span className="inline-flex items-center gap-1.5 font-medium text-amber-700 dark:text-amber-400"><AlertTriangle className="size-4" />Differences found</span>)
          : <span className="text-muted">Not validated yet.</span>}
        {v && <span className="text-xs text-muted">checked {timeAgo(v.at)}</span>}
        {run.mode !== 'dry_run' && !isOpen(run.status) && <Button size="sm" loading={busy} onClick={revalidate}><RefreshCw className="size-3.5" />Re-run validation</Button>}
      </div>
      {v && (
        <div className="grid gap-3 sm:grid-cols-3">
          <Metric label="Lists with matching task counts" value={`${v.lists.length - mismatchedLists.length}/${v.lists.length}`} ok={!mismatchedLists.length} />
          <Metric label="Sampled field values match" value={`${v.fields.checked - v.fields.mismatches.length}/${v.fields.checked}`} ok={!v.fields.mismatches.length} />
          <Metric label="Attachment checksums match" value={`${v.attachments.checked - v.attachments.mismatches.length}/${v.attachments.checked}`} ok={!v.attachments.mismatches.length} />
        </div>
      )}
      {v && (mismatchedLists.length > 0 || v.fields.mismatches.length > 0 || v.attachments.mismatches.length > 0) && (
        <ul className="list-disc space-y-1 pl-5 text-muted">
          {mismatchedLists.map((l) => <li key={l.listExt}>List “{l.name}”: ClickUp {l.clickup} tasks, imported {l.ours}</li>)}
          {v.fields.mismatches.map((m, i) => <li key={`f${i}`}>Task {m.task}, field “{m.field}”: expected <code>{JSON.stringify(m.expected)}</code>, found <code>{JSON.stringify(m.actual)}</code></li>)}
          {v.attachments.mismatches.map((m) => <li key={m.attachment}>{m.filename}: {m.problem}</li>)}
        </ul>
      )}
    </div>
  );
}

function Metric({ label, value, ok }: { label: string; value: string; ok: boolean }) {
  return (
    <div className="rounded-md border border-app bg-subtle px-3 py-2">
      <div className={cx('text-lg font-semibold tabular-nums', ok ? 'text-app' : 'text-amber-700 dark:text-amber-400')}>{value}</div>
      <div className="text-xs text-muted">{label}</div>
    </div>
  );
}

function RunDetails({ run }: { run: Run }) {
  return (
    <>
      <Card
        title="Counts"
        actions={(
          <div className="flex gap-2">
            <a className="inline-flex h-7 items-center gap-1.5 rounded-md border border-app px-2 text-xs font-medium hover-bg" href={`/api/import/runs/${run.id}/report?format=json`} download><FileJson className="size-3.5" />JSON report</a>
            <a className="inline-flex h-7 items-center gap-1.5 rounded-md border border-app px-2 text-xs font-medium hover-bg" href={`/api/import/runs/${run.id}/report?format=csv`} download><FileSpreadsheet className="size-3.5" />CSV report</a>
          </div>
        )}
      >
        <StatsTable run={run} />
      </Card>
      {run.mode !== 'dry_run' && (run.validation || run.status === 'succeeded') && <Card title="Validation"><ValidationView run={run} /></Card>}
      <Card title="Issues"><IssuesTable run={run} /></Card>
    </>
  );
}

// ───────────── user mapping (M-03) ─────────────

const RESOLUTION: Record<Mapping['resolution'], { label: string; color: string }> = {
  auto_email: { label: 'Matched by email', color: '#16a34a' },
  manual: { label: 'Mapped', color: '#2563eb' },
  placeholder: { label: 'Placeholder', color: '#7c3aed' },
  skip: { label: 'Skipped', color: '#64748b' },
  unresolved: { label: 'Needs review', color: '#d97706' },
};

function UserMapping({ awaiting, runId }: { awaiting: boolean; runId: string | null }) {
  const qc = useQueryClient();
  const { data: users = [] } = useUsers();
  const { data, isLoading } = useQuery({ queryKey: QK.users, queryFn: () => api.get<Mapping[]>('/import/users') });
  const [busy, setBusy] = useState<string | null>(null);
  const refresh = () => void qc.invalidateQueries({ queryKey: ['import'] });
  const run = async (key: string, fn: () => Promise<unknown>) => {
    setBusy(key);
    try {
      await fn();
      refresh();
    } finally {
      setBusy(null);
    }
  };
  const set = (m: Mapping, body: Record<string, unknown>) => run(m.clickupUserId, () => api.put(`/import/users/${m.clickupUserId}`, body));
  const unresolved = data?.filter((m) => m.resolution === 'unresolved').length ?? 0;
  const candidates = users.filter((u) => !u.isSystem);

  return (
    <Card
      title="User mapping"
      actions={(
        <div className="flex flex-wrap gap-2">
          <Button size="sm" loading={busy === 'fetch'} onClick={() => run('fetch', async () => {
            const r = await api.post<{ members: number; created: number }>('/import/users/refresh');
            toast.ok(`${r.members} ClickUp members (${r.created} new)`);
          })}><RefreshCw className="size-3.5" />Fetch members</Button>
          {unresolved > 0 && (
            <>
              <Button size="sm" loading={busy === 'bulk-p'} onClick={() => run('bulk-p', () => api.post('/import/users/bulk', { kind: 'placeholder' }))}>Placeholders for all {unresolved}</Button>
              <Button size="sm" variant="ghost" loading={busy === 'bulk-s'} onClick={() => run('bulk-s', () => api.post('/import/users/bulk', { kind: 'skip' }))}>Skip all</Button>
            </>
          )}
          {awaiting && runId && unresolved === 0 && (
            <Button size="sm" variant="primary" loading={busy === 'resume'} onClick={() => run('resume', () => api.post(`/import/runs/${runId}/resume`))}><Play className="size-3.5" />Resume import</Button>
          )}
        </div>
      )}
    >
      <p className="mb-3 text-sm text-muted">
        ClickUp members are matched to people here by email. For the rest, pick an existing person, create a <strong className="font-medium text-app">placeholder</strong> (it is linked automatically when they first sign in with SSO using the same email) or skip them — their tasks and comments are then attributed to “ClickUp import”.
      </p>
      {isLoading ? <Loading /> : !data?.length ? (
        <Empty title="No ClickUp members yet">Fetch members, or start an import — the first stage loads them.</Empty>
      ) : (
        <div className="overflow-x-auto rounded-md border border-app">
          <table className="w-full text-sm">
            <thead className="bg-subtle text-left text-xs text-muted">
              <tr>
                <th className="px-3 py-1.5 font-medium">ClickUp member</th>
                <th className="px-3 font-medium">Status</th>
                <th className="px-3 font-medium">Person here</th>
                <th className="px-3 font-medium" />
              </tr>
            </thead>
            <tbody>
              {data.map((m) => (
                <tr key={m.clickupUserId} className={cx('border-t border-app', m.resolution === 'unresolved' && 'bg-amber-50/60 dark:bg-amber-500/5')}>
                  <td className="px-3 py-2">
                    <div className="font-medium">{m.clickupName ?? m.clickupUserId}</div>
                    <div className="text-xs text-muted">{m.clickupEmail ?? 'no email'}</div>
                  </td>
                  <td className="px-3"><Badge color={RESOLUTION[m.resolution].color}>{RESOLUTION[m.resolution].label}</Badge></td>
                  <td className="px-3">
                    <Select className="w-72" value={m.userId ?? ''} disabled={busy === m.clickupUserId}
                      onChange={(e) => e.target.value ? set(m, { kind: 'map', userId: e.target.value }) : set(m, { kind: 'reset' })}>
                      <option value="">— not mapped —</option>
                      {m.user && !candidates.some((u) => u.id === m.user!.id) && <option value={m.user.id}>{m.user.displayName}</option>}
                      {candidates.map((u) => <option key={u.id} value={u.id}>{u.displayName}{u.isPlaceholder ? ' (placeholder)' : ''} — {u.email}</option>)}
                    </Select>
                  </td>
                  <td className="whitespace-nowrap px-3 text-right">
                    {m.resolution === 'unresolved' ? (
                      <div className="inline-flex gap-1">
                        <Button size="sm" onClick={() => set(m, { kind: 'placeholder', role: 3 })}>Placeholder</Button>
                        <Button size="sm" variant="ghost" onClick={() => set(m, { kind: 'placeholder', role: 4 })} title="Create a placeholder guest">as guest</Button>
                        <Button size="sm" variant="ghost" onClick={() => set(m, { kind: 'skip' })}>Skip</Button>
                      </div>
                    ) : (
                      <Button size="sm" variant="ghost" onClick={() => set(m, { kind: 'reset' })}>Reset</Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

// ───────────── history ─────────────

function History({ selected, onSelect }: { selected: string | null; onSelect: (id: string | null) => void }) {
  const { data: runs, isLoading } = useQuery({ queryKey: QK.runs, queryFn: () => api.get<Run[]>('/import/runs'), refetchInterval: 10_000 });
  const current = runs?.find((r) => r.id === selected) ?? runs?.[0] ?? null;
  if (isLoading) return <Loading />;
  if (!runs?.length) return <Empty title="No imports yet">Start with a dry run to see what would be imported.</Empty>;
  const total = (s: Record<string, Counts>, k: string) => s[k] ? (s[k].created ?? 0) + (s[k].updated ?? 0) : 0;
  return (
    <div className="space-y-5">
      <Card title="Runs">
        <div className="overflow-x-auto rounded-md border border-app">
          <table className="w-full text-sm">
            <thead className="bg-subtle text-left text-xs text-muted">
              <tr>
                <th className="px-3 py-1.5 font-medium">Started</th>
                <th className="px-3 font-medium">Mode</th>
                <th className="px-3 font-medium">Status</th>
                <th className="px-3 font-medium">Duration</th>
                <th className="px-3 text-right font-medium">Tasks</th>
                <th className="px-3 text-right font-medium">Issues</th>
              </tr>
            </thead>
            <tbody>
              {runs.map((r) => (
                <tr key={r.id} onClick={() => onSelect(r.id)} className={cx('cursor-pointer border-t border-app hover-bg', current?.id === r.id && 'bg-muted')}>
                  <td className="whitespace-nowrap px-3 py-1.5">{fmt(r.startedAt ?? r.createdAt)}</td>
                  <td className="px-3">{MODE_LABEL[r.mode]}</td>
                  <td className="px-3"><StatusBadge status={r.status} /></td>
                  <td className="px-3 text-muted">{duration(r.startedAt, r.finishedAt)}</td>
                  <td className="px-3 text-right tabular-nums">{total(r.stats, 'task') || '—'}</td>
                  <td className="px-3 text-right tabular-nums text-muted">
                    {r.issueCounts.error ? <span className="text-red-600 dark:text-red-400">{r.issueCounts.error} err · </span> : null}
                    {(r.issueCounts.warn ?? 0)} warn
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
      {current && (
        <>
          <h3 className="text-sm font-semibold">{MODE_LABEL[current.mode]} · {fmt(current.startedAt ?? current.createdAt)} <StatusBadge status={current.status} /></h3>
          {current.error && <p className="text-sm text-red-600 dark:text-red-400">{current.error}</p>}
          <RunDetails run={current} />
        </>
      )}
    </div>
  );
}
