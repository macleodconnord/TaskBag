import { useQueryClient } from '@tanstack/react-query';
import { Settings } from 'lucide-react';
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { setUserTimezone } from '@/lib/format';
import { keys, useMe } from '@/lib/queries';
import { setTheme, type Theme } from '@/lib/theme';
import { NotificationPrefs } from '@/features/notifications/NotificationPrefs';
import { toast } from '@/components/toast';
import { Avatar, Button, Field, Input, Loading, PageHeader, Select } from '@/components/ui';

const ZONES = typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('timeZone') : ['America/Chicago', 'UTC'];

export function SettingsPage() {
  const { data } = useMe();
  const qc = useQueryClient();
  const [name, setName] = useState('');
  const [tz, setTz] = useState('');
  const [theme, setThemeState] = useState<Theme>('system');
  useEffect(() => {
    if (!data) return;
    setName(data.user.displayName);
    setTz(data.user.timezone ?? '');
    setThemeState(data.user.theme);
  }, [data]);
  if (!data) return <Loading />;
  const save = async () => {
    await api.patch('/users/me', { displayName: name, timezone: tz || null, theme });
    setTheme(theme);
    setUserTimezone(tz || null);
    await qc.invalidateQueries({ queryKey: keys.me });
    void qc.invalidateQueries({ queryKey: keys.users });
    toast.ok('Settings saved');
  };
  return (
    <div className="flex h-full flex-col">
      <PageHeader title="Settings" icon={<Settings className="size-5 text-muted" />} />
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-2xl space-y-8 px-6 py-6">
          <section className="space-y-4">
            <h2 className="font-semibold">Profile</h2>
            <div className="flex items-center gap-3">
              <Avatar user={data.user} size={48} />
              <div>
                <div className="font-medium">{data.user.email}</div>
                <div className="text-sm capitalize text-muted">{data.user.role}</div>
              </div>
            </div>
            <Field label="Display name"><Input value={name} onChange={(e) => setName(e.target.value)} /></Field>
            <Field label="Timezone" hint="— due dates, reminders and digests use it">
              <Select value={tz} onChange={(e) => setTz(e.target.value)}>
                <option value="">Workspace default (America/Chicago)</option>
                {ZONES.map((z) => <option key={z} value={z}>{z}</option>)}
              </Select>
            </Field>
            <Field label="Theme">
              <Select value={theme} onChange={(e) => setThemeState(e.target.value as Theme)}>
                <option value="system">Match system</option>
                <option value="light">Light</option>
                <option value="dark">Dark</option>
              </Select>
            </Field>
            <Button variant="primary" onClick={save} disabled={!name.trim()}>Save profile</Button>
          </section>
          <NotificationPrefs />
        </div>
      </div>
    </div>
  );
}
