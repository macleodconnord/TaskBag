import { INTEGRATION_DESCRIPTORS, INTEGRATION_KEYS, type IntegrationField, type IntegrationKey } from '@app/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, KeyRound, Plug, XCircle } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router';
import { api } from '@/lib/api';
import { formatDate, timeAgo, toDateInput } from '@/lib/format';
import { useMe } from '@/lib/queries';
import { toast } from '@/components/toast';
import { Button, Checkbox, cx, Empty, Field, Input, Loading, PageHeader, Select, Textarea, useDialogs } from '@/components/ui';
import { Card, CopyField, HealthBadge, HealthDot, randomSecret, SyncLogTable, type Health, type SyncLog } from './common';
import { NinjaOnePanel } from './NinjaOnePanel';

interface SecretMeta {
  name: string;
  set: boolean;
  masked: string | null;
  updatedAt: string | null;
  updatedBy: { id: string; displayName: string } | null;
  expiresAt: string | null;
}
export interface IntegrationState {
  key: IntegrationKey;
  enabled: boolean;
  config: Record<string, unknown>;
  secrets: SecretMeta[];
  health: Health;
  healthDetail: string | null;
  lastSuccessAt: string | null;
  updatedAt: string | null;
  updatedBy: { id: string; displayName: string } | null;
  extra: { webhookUrl?: string };
}
interface TestResult { ok: boolean; detail: string; testedAt: string }

const QK = ['admin-integrations'] as const;
/** a date input value → that day's end in local time (so the expiry shows on the chosen date) */
const endOfDay = (d: string) => new Date(`${d}T23:59:59`).toISOString();

export function AdminIntegrationsPage() {
  const { data: me } = useMe();
  const [params, setParams] = useSearchParams();
  const selected = (INTEGRATION_KEYS as readonly string[]).includes(params.get('i') ?? '') ? (params.get('i') as IntegrationKey) : 'entra';
  const { data, isLoading } = useQuery({ queryKey: QK, queryFn: () => api.get<IntegrationState[]>('/integrations'), refetchInterval: 30_000 });
  const isAdmin = me && (me.user.role === 'owner' || me.user.role === 'admin');
  if (me && !isAdmin) return <Empty title="Admins only" />;
  const current = data?.find((i) => i.key === selected);

  return (
    <div className="flex h-full flex-col">
      <PageHeader title="Integrations & credentials" icon={<Plug className="size-5 text-muted" />} />
      <div className="flex min-h-0 flex-1 flex-col md:flex-row">
        <nav className="flex shrink-0 gap-1 overflow-x-auto border-b border-app p-2 md:w-60 md:flex-col md:overflow-visible md:border-b-0 md:border-r">
          {INTEGRATION_KEYS.map((k) => {
            const st = data?.find((i) => i.key === k);
            return (
              <button
                key={k}
                onClick={() => setParams({ i: k }, { replace: true })}
                className={cx('flex items-center gap-2 whitespace-nowrap rounded-md px-2.5 py-2 text-left text-sm', k === selected ? 'bg-muted font-medium text-app' : 'text-muted hover-bg hover:text-app')}
              >
                <HealthDot health={st?.health ?? 'unknown'} />
                <span className="truncate">{INTEGRATION_DESCRIPTORS[k].name}</span>
              </button>
            );
          })}
        </nav>
        <div className="min-h-0 flex-1 overflow-y-auto p-5">
          {isLoading || !current ? <Loading /> : <IntegrationPanel key={current.key} state={current} />}
        </div>
      </div>
    </div>
  );
}

function IntegrationPanel({ state }: { state: IntegrationState }) {
  const qc = useQueryClient();
  const d = INTEGRATION_DESCRIPTORS[state.key];
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: QK });
    void qc.invalidateQueries({ queryKey: ['integration-logs', state.key] });
  };
  const toggle = useMutation({
    mutationFn: (enabled: boolean) => api.put(`/integrations/${state.key}`, { enabled }),
    onSuccess: (_r, enabled) => { toast.ok(enabled ? `${d.name} enabled` : `${d.name} disabled`); refresh(); },
  });

  return (
    <div className="max-w-3xl space-y-6">
      <div className="flex flex-wrap items-start gap-4">
        <div className="min-w-0 flex-1">
          <h2 className="text-lg font-semibold">{d.name}</h2>
          <p className="mt-0.5 text-sm text-muted">{d.description}</p>
          <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted">
            <HealthBadge health={state.health} />
            {state.healthDetail && <span className="break-words">{state.healthDetail}</span>}
            {state.lastSuccessAt && <span>Last success {timeAgo(state.lastSuccessAt)}</span>}
          </div>
        </div>
        <Checkbox checked={state.enabled} onChange={(v) => toggle.mutate(v)} disabled={toggle.isPending} label={<span className="font-medium">Enabled</span>} />
      </div>

      {state.key === 'gitea' && state.extra.webhookUrl && (
        <Card title="Webhook URL">
          <p className="mb-2 text-xs text-muted">In Gitea: repository or organization → Settings → Webhooks → Add webhook → Gitea. Content type <code>application/json</code>, the secret below, events: push, create, pull request.</p>
          <CopyField value={state.extra.webhookUrl} />
        </Card>
      )}

      <SettingsForm state={state} onSaved={refresh} />
      <SecretsCard state={state} onSaved={refresh} />
      <TestCard state={state} onDone={refresh} />
      {state.key === 'ninjaone' && <NinjaOnePanel />}
      <LogsCard integrationKey={state.key} />
    </div>
  );
}

// ───────────── settings (non-secret fields) ─────────────

const toDraft = (f: IntegrationField, v: unknown): unknown => {
  const value = v ?? f.default;
  if (f.type === 'list') return Array.isArray(value) ? value.join('\n') : '';
  if (f.type === 'boolean') return value === true;
  return value === undefined || value === null ? '' : String(value);
};
const fromDraft = (f: IntegrationField, v: unknown): unknown => {
  if (f.type === 'list') return String(v ?? '').split(/[\n,]/).map((s) => s.trim()).filter(Boolean);
  if (f.type === 'boolean') return v === true;
  return v;
};

function SettingsForm({ state, onSaved }: { state: IntegrationState; onSaved: () => void }) {
  const fields = INTEGRATION_DESCRIPTORS[state.key].fields.filter((f) => f.type !== 'secret');
  const initial = () => Object.fromEntries(fields.map((f) => [f.name, toDraft(f, state.config[f.name])]));
  const [draft, setDraft] = useState<Record<string, unknown>>(initial);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => setDraft(initial()), [JSON.stringify(state.config)]);
  const dirty = fields.some((f) => JSON.stringify(draft[f.name]) !== JSON.stringify(toDraft(f, state.config[f.name])));
  const save = useMutation({
    mutationFn: () => api.put(`/integrations/${state.key}`, { config: Object.fromEntries(fields.map((f) => [f.name, fromDraft(f, draft[f.name])])) }),
    onSuccess: () => { toast.ok('Settings saved — in effect now'); onSaved(); },
  });
  if (!fields.length) return null;
  const set = (k: string, v: unknown) => setDraft((d) => ({ ...d, [k]: v }));

  return (
    <Card
      title="Settings"
      action={state.updatedBy && state.updatedAt ? <span className="text-xs text-muted">Last changed by {state.updatedBy.displayName} on {formatDate(state.updatedAt, true)}</span> : undefined}
    >
      <form className="grid gap-4 sm:grid-cols-2" onSubmit={(e) => { e.preventDefault(); save.mutate(); }}>
        {fields.map((f) => (
          <div key={f.name} className={cx((f.type === 'list' || f.type === 'textarea' || f.type === 'boolean') && 'sm:col-span-2')}>
            {f.type === 'boolean' ? (
              <Checkbox checked={draft[f.name] === true} onChange={(v) => set(f.name, v)} label={f.label} />
            ) : (
              <Field label={<>{f.label}{f.required && <span className="text-red-500"> *</span>}</>}>
                <FieldInput field={f} value={draft[f.name]} onChange={(v) => set(f.name, v)} />
              </Field>
            )}
            {f.help && <p className="mt-1 text-xs text-subtle">{f.help}</p>}
          </div>
        ))}
        <div className="flex items-center gap-2 sm:col-span-2">
          <Button type="submit" variant="primary" loading={save.isPending} disabled={!dirty}>Save settings</Button>
          {dirty && <Button type="button" variant="ghost" onClick={() => setDraft(initial())}>Discard</Button>}
        </div>
      </form>
    </Card>
  );
}

function FieldInput({ field: f, value, onChange }: { field: IntegrationField; value: unknown; onChange: (v: unknown) => void }) {
  const v = String(value ?? '');
  switch (f.type) {
    case 'select':
      return (
        <Select value={v} onChange={(e) => onChange(e.target.value)}>
          {f.options?.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </Select>
      );
    case 'list':
      return <Textarea rows={3} value={v} placeholder={f.placeholder ? `${f.placeholder} (one per line)` : 'One per line'} onChange={(e) => onChange(e.target.value)} className="font-mono text-xs" />;
    case 'textarea':
      return <Textarea rows={4} value={v} placeholder={f.placeholder} onChange={(e) => onChange(e.target.value)} />;
    case 'number':
      return <Input type="number" value={v} min={f.min} max={f.max} placeholder={f.placeholder ?? (f.default !== undefined ? String(f.default) : undefined)} onChange={(e) => onChange(e.target.value)} />;
    default:
      return <Input type={f.type === 'url' ? 'url' : 'text'} value={v} placeholder={f.placeholder} onChange={(e) => onChange(e.target.value)} />;
  }
}

// ───────────── secrets (write-only) ─────────────

function SecretsCard({ state, onSaved }: { state: IntegrationState; onSaved: () => void }) {
  const fields = INTEGRATION_DESCRIPTORS[state.key].fields.filter((f) => f.type === 'secret');
  if (!fields.length) return null;
  return (
    <Card title="Credentials">
      <p className="mb-3 flex items-center gap-1.5 text-xs text-muted"><KeyRound className="size-3.5" />Secrets are encrypted at rest and write-only: they're never shown again after saving.</p>
      <div className="divide-y divide-[var(--border)]">
        {fields.map((f) => (
          <SecretRow key={f.name} integrationKey={state.key} field={f} meta={state.secrets.find((s) => s.name === f.name)} onSaved={onSaved} />
        ))}
      </div>
    </Card>
  );
}

function SecretRow({ integrationKey, field: f, meta, onSaved }: { integrationKey: IntegrationKey; field: IntegrationField; meta?: SecretMeta; onSaved: () => void }) {
  const dialogs = useDialogs();
  const [value, setValue] = useState('');
  const [generated, setGenerated] = useState(false);
  const [expires, setExpires] = useState(toDateInput(meta?.expiresAt));
  useEffect(() => setExpires(toDateInput(meta?.expiresAt)), [meta?.expiresAt]);
  const put = useMutation({
    mutationFn: (body: { value?: string | null; expiresAt?: string | null }) => api.put(`/integrations/${integrationKey}/secrets/${f.name}`, body),
    onSuccess: (_r, body) => {
      toast.ok(body.value === null ? `${f.label} cleared` : body.value ? `${f.label} saved` : 'Expiry date saved');
      if (body.value) { setValue(''); setGenerated(false); }
      onSaved();
    },
  });
  const expiryDays = meta?.expiresAt ? Math.ceil((new Date(meta.expiresAt).getTime() - Date.now()) / 86_400_000) : null;

  return (
    <div className="grid gap-2 py-3 first:pt-0 last:pb-0">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="text-sm font-medium">{f.label}</span>
        {meta?.set ? (
          <span className="text-xs text-muted">
            <span className="font-mono tracking-widest">{meta.masked}</span>
            {meta.updatedAt && <> · last changed{meta.updatedBy ? ` by ${meta.updatedBy.displayName}` : ''} on {formatDate(meta.updatedAt, true)}</>}
          </span>
        ) : <span className="text-xs text-amber-700 dark:text-amber-400">Not set</span>}
        {expiryDays !== null && (
          <span className={cx('text-xs', expiryDays <= 0 ? 'text-red-600 dark:text-red-400' : expiryDays <= 30 ? 'text-amber-700 dark:text-amber-400' : 'text-muted')}>
            {expiryDays <= 0 ? 'Expired' : `Expires in ${expiryDays} day${expiryDays === 1 ? '' : 's'}`} ({formatDate(meta!.expiresAt)})
          </span>
        )}
      </div>
      {f.help && <p className="text-xs text-subtle">{f.help}</p>}
      <form className="flex flex-wrap items-center gap-2" onSubmit={(e) => { e.preventDefault(); if (value) put.mutate({ value, ...(f.expires && expires ? { expiresAt: endOfDay(expires) } : {}) }); }}>
        <Input
          type={generated ? 'text' : 'password'}
          autoComplete="new-password"
          className={cx('w-72 min-w-0 flex-1', generated && 'font-mono text-xs')}
          placeholder={meta?.set ? 'Enter a new value to replace it' : 'Enter value'}
          value={value}
          onChange={(e) => { setValue(e.target.value); setGenerated(false); }}
        />
        {f.generate && <Button type="button" onClick={() => { setValue(randomSecret()); setGenerated(true); }}>Generate</Button>}
        <Button type="submit" variant="primary" disabled={!value} loading={put.isPending && !!value}>{meta?.set ? 'Replace' : 'Save'}</Button>
        {meta?.set && (
          <Button type="button" variant="ghost" onClick={async () => { if (await dialogs.confirm({ title: `Clear ${f.label}?`, body: 'The integration stops working until a new value is saved.', confirm: 'Clear', danger: true })) put.mutate({ value: null }); }}>
            Clear
          </Button>
        )}
      </form>
      {generated && <p className="text-xs text-amber-700 dark:text-amber-400">Copy this value now (e.g. into Gitea) — after saving it can't be shown again.</p>}
      {f.expires && (
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
          <span>Expires on</span>
          <Input type="date" className="h-7 w-40 text-xs" value={expires} onChange={(e) => setExpires(e.target.value)} />
          {meta?.set && expires !== toDateInput(meta.expiresAt) && (
            <Button size="sm" onClick={() => put.mutate({ expiresAt: expires ? endOfDay(expires) : null })}>Save date</Button>
          )}
          <span className="text-subtle">Admins are reminded 30, 7 and 1 days before.</span>
        </div>
      )}
    </div>
  );
}

// ───────────── test connection + logs ─────────────

function TestCard({ state, onDone }: { state: IntegrationState; onDone: () => void }) {
  const [result, setResult] = useState<TestResult | null>(null);
  const test = useMutation({
    mutationFn: () => api.post<TestResult>(`/integrations/${state.key}/test`),
    onSuccess: (r) => { setResult(r); onDone(); },
  });
  return (
    <Card title="Test connection">
      <div className="flex flex-wrap items-center gap-3">
        <Button onClick={() => test.mutate()} loading={test.isPending}>{INTEGRATION_DESCRIPTORS[state.key].testLabel}</Button>
        {!state.enabled && <span className="text-xs text-subtle">You can test before enabling.</span>}
      </div>
      {result && (
        <div className={cx('mt-3 rounded-md border p-3 text-sm', result.ok ? 'border-emerald-300 bg-emerald-50 dark:border-emerald-900 dark:bg-emerald-950/40' : 'border-red-300 bg-red-50 dark:border-red-900 dark:bg-red-950/40')}>
          <div className={cx('mb-1 flex items-center gap-1.5 font-medium', result.ok ? 'text-emerald-800 dark:text-emerald-300' : 'text-red-800 dark:text-red-300')}>
            {result.ok ? <CheckCircle2 className="size-4" /> : <XCircle className="size-4" />}
            {result.ok ? 'Connection OK' : 'Connection failed'}
            <span className="ml-auto text-xs font-normal text-muted">{new Date(result.testedAt).toLocaleTimeString()}</span>
          </div>
          <pre className="whitespace-pre-wrap break-words font-sans text-xs text-app">{result.detail}</pre>
        </div>
      )}
    </Card>
  );
}

function LogsCard({ integrationKey }: { integrationKey: IntegrationKey }) {
  const { data } = useQuery({
    queryKey: ['integration-logs', integrationKey],
    queryFn: () => api.get<SyncLog[]>(`/integrations/${integrationKey}/logs?limit=20`),
    refetchInterval: 30_000,
  });
  return (
    <Card title="Recent activity">
      {data ? <SyncLogTable logs={data} /> : <Loading />}
    </Card>
  );
}
