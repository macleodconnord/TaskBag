import { useQueryClient } from '@tanstack/react-query';
import { RotateCcw } from 'lucide-react';
import { useState } from 'react';
import { api } from '@/lib/api';
import { toast } from '@/components/toast';
import { Button, Checkbox, Loading, Select, Tabs, cx } from '@/components/ui';
import { EVENT_LABELS, nkeys, usePrefs, type Cell, type Digest } from './api';

type Matrix = Record<string, Record<'in_app' | 'email', Cell>>;

/** Settings section: per event type × channel (in-app, email) with instant / hourly / daily email. */
export function NotificationPrefs() {
  const { data, isLoading } = usePrefs();
  const qc = useQueryClient();
  const [scope, setScope] = useState<'mine' | 'workspace'>('mine');
  if (isLoading || !data) return <section><h2 className="mb-3 font-semibold">Notifications</h2><Loading /></section>;
  const refresh = () => qc.invalidateQueries({ queryKey: nkeys.prefs });

  const saveMine = async (eventType: string, channel: 'in_app' | 'email', value: Cell | null) => {
    await api.put('/notifications/preferences', { eventType, channel, value: value && { enabled: value.enabled, digest: value.digest } });
    await refresh();
  };
  const saveDefault = async (eventType: string, channel: 'in_app' | 'email', value: Cell) => {
    await api.put('/notifications/defaults', { [eventType]: { [channel]: { enabled: value.enabled, digest: value.digest } } });
    await refresh();
    toast.ok('Workspace default saved');
  };
  const resetAll = async () => {
    await api.delete('/notifications/preferences');
    await refresh();
    toast.ok('Notification settings reset to workspace defaults');
  };

  const workspace = scope === 'workspace';
  return (
    <section className="space-y-3">
      <div className="flex items-center gap-3">
        <h2 className="flex-1 font-semibold">Notifications</h2>
        {!workspace && <Button size="sm" variant="ghost" onClick={resetAll}><RotateCcw className="size-3.5" /> Reset to defaults</Button>}
      </div>
      {data.isAdmin && (
        <Tabs value={scope} onChange={setScope} items={[{ value: 'mine', label: 'My settings' }, { value: 'workspace', label: 'Workspace defaults' }]} />
      )}
      <p className="text-sm text-muted">
        {workspace
          ? 'Defaults for everyone who hasn’t changed a setting themselves.'
          : 'You’re only notified about tasks and docs you can see. Email digests are sent hourly, or daily at 08:00 in your timezone.'}
      </p>
      <PrefTable
        events={data.events.filter((e) => !workspace || e !== 'admin_alert' || data.isAdmin)}
        matrix={(workspace ? data.defaults : data.matrix) as Matrix}
        showOverrides={!workspace}
        onChange={(e, c, v) => (workspace ? saveDefault(e, c, v) : saveMine(e, c, v))}
        onReset={workspace ? undefined : (e, c) => saveMine(e, c, null)}
      />
    </section>
  );
}

function PrefTable({ events, matrix, showOverrides, onChange, onReset }: {
  events: string[];
  matrix: Matrix;
  showOverrides: boolean;
  onChange: (event: string, channel: 'in_app' | 'email', value: Cell) => void;
  onReset?: (event: string, channel: 'in_app' | 'email') => void;
}) {
  return (
    <div className="overflow-hidden rounded-lg border border-app">
      <table className="w-full text-sm">
        <thead className="bg-subtle text-left text-xs text-muted">
          <tr>
            <th className="px-3 py-2 font-medium">Event</th>
            <th className="w-20 px-3 py-2 text-center font-medium">In-app</th>
            <th className="w-48 px-3 py-2 font-medium">Email</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-[var(--border)]">
          {events.map((e) => {
            const row = matrix[e];
            if (!row) return null;
            const meta = EVENT_LABELS[e] ?? { label: e, hint: '' };
            const changed = showOverrides && (row.in_app.overridden || row.email.overridden);
            return (
              <tr key={e} className="align-middle">
                <td className="px-3 py-2">
                  <div className="flex items-center gap-1.5">
                    <span className="font-medium">{meta.label}</span>
                    {changed && onReset && (
                      <button
                        className="text-xs text-subtle hover:text-app"
                        title="Use the workspace default"
                        onClick={() => { if (row.in_app.overridden) onReset(e, 'in_app'); if (row.email.overridden) onReset(e, 'email'); }}
                      >
                        <RotateCcw className="size-3" />
                      </button>
                    )}
                  </div>
                  <div className="text-xs text-muted">{meta.hint}</div>
                </td>
                <td className="px-3 py-2">
                  <div className="flex justify-center">
                    <Checkbox checked={row.in_app.enabled} onChange={(v) => onChange(e, 'in_app', { ...row.in_app, enabled: v })} />
                  </div>
                </td>
                <td className="px-3 py-2">
                  <div className="flex items-center gap-2">
                    <Checkbox checked={row.email.enabled} onChange={(v) => onChange(e, 'email', { ...row.email, enabled: v })} />
                    <Select
                      className={cx('h-7 w-28 text-xs', !row.email.enabled && 'opacity-50')}
                      disabled={!row.email.enabled}
                      value={row.email.digest}
                      onChange={(ev) => onChange(e, 'email', { ...row.email, digest: ev.target.value as Digest })}
                      aria-label={`${meta.label} email frequency`}
                    >
                      <option value="instant">Instantly</option>
                      <option value="hourly">Hourly digest</option>
                      <option value="daily">Daily digest</option>
                    </Select>
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
