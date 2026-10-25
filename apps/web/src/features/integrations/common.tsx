import type { ReactNode } from 'react';
import { useTree } from '@/lib/queries';
import { cx, Select } from '@/components/ui';

export type Health = 'ok' | 'degraded' | 'down' | 'unknown' | 'disabled';

const HEALTH: Record<Health, { label: string; dot: string; text: string }> = {
  ok: { label: 'Healthy', dot: 'bg-emerald-500', text: 'text-emerald-700 dark:text-emerald-400' },
  degraded: { label: 'Degraded', dot: 'bg-amber-500', text: 'text-amber-700 dark:text-amber-400' },
  down: { label: 'Failing', dot: 'bg-red-500', text: 'text-red-700 dark:text-red-400' },
  unknown: { label: 'Not tested', dot: 'bg-slate-400', text: 'text-muted' },
  disabled: { label: 'Disabled', dot: 'bg-slate-300 dark:bg-slate-600', text: 'text-subtle' },
};

export function HealthDot({ health, className }: { health: Health; className?: string }) {
  return <span className={cx('inline-block size-2 shrink-0 rounded-full', HEALTH[health].dot, className)} title={HEALTH[health].label} />;
}

export function HealthBadge({ health }: { health: Health }) {
  return (
    <span className={cx('inline-flex items-center gap-1.5 text-xs font-medium', HEALTH[health].text)}>
      <HealthDot health={health} />
      {HEALTH[health].label}
    </span>
  );
}

export interface SyncLog {
  id: number;
  integrationKey: string;
  jobName: string;
  status: 'running' | 'ok' | 'error';
  startedAt: string;
  finishedAt: string | null;
  stats: Record<string, unknown> | null;
  error: string | null;
}

const statText = (s: Record<string, unknown> | null) =>
  s ? Object.entries(s).filter(([, v]) => v !== null && v !== undefined && typeof v !== 'object' && v !== 0).map(([k, v]) => `${k}: ${v}`).join(' · ') : '';

export function SyncLogTable({ logs }: { logs: SyncLog[] }) {
  if (!logs.length) return <div className="rounded-md border border-dashed border-app p-3 text-sm text-muted">No runs yet.</div>;
  return (
    <div className="overflow-x-auto rounded-md border border-app">
      <table className="w-full text-xs">
        <thead className="bg-subtle text-left text-muted">
          <tr>
            <th className="px-2 py-1.5 font-medium">When</th>
            <th className="px-2 font-medium">Job</th>
            <th className="px-2 font-medium">Result</th>
            <th className="px-2 font-medium">Duration</th>
            <th className="px-2 font-medium">Details</th>
          </tr>
        </thead>
        <tbody>
          {logs.map((l) => (
            <tr key={l.id} className="border-t border-app align-top">
              <td className="whitespace-nowrap px-2 py-1.5 text-muted">{new Date(l.startedAt).toLocaleString()}</td>
              <td className="whitespace-nowrap px-2 py-1.5 font-mono">{l.jobName}</td>
              <td className="px-2 py-1.5">
                <span className={cx('font-medium', l.status === 'ok' ? 'text-emerald-700 dark:text-emerald-400' : l.status === 'error' ? 'text-red-700 dark:text-red-400' : 'text-muted')}>{l.status}</span>
              </td>
              <td className="whitespace-nowrap px-2 py-1.5 text-muted">{l.finishedAt ? `${((new Date(l.finishedAt).getTime() - new Date(l.startedAt).getTime()) / 1000).toFixed(1)}s` : '…'}</td>
              <td className="max-w-md break-words px-2 py-1.5 text-muted">{l.error ?? statText(l.stats)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** List picker grouped by Space (and Folder). */
export function ListSelect({ value, onChange, className, allowEmpty = true }: { value: string; onChange: (id: string) => void; className?: string; allowEmpty?: boolean }) {
  const { data: tree } = useTree();
  return (
    <Select value={value} onChange={(e) => onChange(e.target.value)} className={className}>
      {allowEmpty && <option value="">Choose a List…</option>}
      {tree?.spaces.map((s) => (
        <optgroup key={s.id} label={s.name}>
          {s.lists.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
          {s.folders.flatMap((f) => f.lists.map((l) => <option key={l.id} value={l.id}>{f.name} / {l.name}</option>))}
        </optgroup>
      ))}
    </Select>
  );
}

/** Space / Folder / List picker for a webhook scope. */
export function ScopeSelect({ type, value, onChange }: { type: 'space' | 'folder' | 'list'; value: string; onChange: (id: string) => void }) {
  const { data: tree } = useTree();
  if (type === 'list') return <ListSelect value={value} onChange={onChange} />;
  return (
    <Select value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="">Choose…</option>
      {type === 'space'
        ? tree?.spaces.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)
        : tree?.spaces.map((s) => (
          <optgroup key={s.id} label={s.name}>
            {s.folders.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
          </optgroup>
        ))}
    </Select>
  );
}

export function randomSecret(bytes = 32) {
  const a = new Uint8Array(bytes);
  crypto.getRandomValues(a);
  return btoa(String.fromCharCode(...a)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function CopyField({ value }: { value: string }) {
  return (
    <div className="flex items-center gap-2">
      <code className="min-w-0 flex-1 truncate rounded-md border border-app bg-subtle px-2.5 py-1.5 font-mono text-xs">{value}</code>
      <button
        type="button"
        className="h-8 shrink-0 rounded-md border border-app px-2.5 text-xs font-medium hover-bg"
        onClick={() => void navigator.clipboard?.writeText(value)}
      >
        Copy
      </button>
    </div>
  );
}

export function Card({ title, children, action }: { title: string; children: ReactNode; action?: ReactNode }) {
  return (
    <section className="rounded-lg border border-app bg-app">
      <div className="flex items-center gap-2 border-b border-app px-4 py-2.5">
        <h3 className="flex-1 text-sm font-semibold">{title}</h3>
        {action}
      </div>
      <div className="p-4">{children}</div>
    </section>
  );
}

