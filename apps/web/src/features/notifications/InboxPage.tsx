import {
  AlarmClock, AlertTriangle, AtSign, BellOff, Check, CheckCheck, CircleDot, Clock, FileText, Inbox, MailOpen, MessageSquare,
  Shield, UserPlus, X,
} from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router';
import { api } from '@/lib/api';
import { formatDate, timeAgo } from '@/lib/format';
import { useOpenTask } from '@/components/task/TaskDrawer';
import { Avatar, Button, Empty, IconButton, Loading, MenuItem, MenuLabel, PageHeader, Popover, Select, Tabs, cx } from '@/components/ui';
import { EVENT_LABELS, refreshInbox, useInbox, type InboxFilter, type InboxItem } from './api';

const ICONS: Record<string, ReactNode> = {
  assigned: <UserPlus className="size-3.5" />,
  mentioned: <AtSign className="size-3.5" />,
  commented: <MessageSquare className="size-3.5" />,
  status_changed: <CircleDot className="size-3.5" />,
  due_soon: <Clock className="size-3.5" />,
  overdue: <AlertTriangle className="size-3.5" />,
  admin_alert: <Shield className="size-3.5" />,
};

function snoozeOptions() {
  const now = new Date();
  const at = (days: number, hour: number) => {
    const d = new Date(now);
    d.setDate(d.getDate() + days);
    d.setHours(hour, 0, 0, 0);
    return d;
  };
  const toMonday = ((8 - now.getDay()) % 7) || 7;
  return [
    { label: 'In 1 hour', until: new Date(now.getTime() + 3_600_000) },
    { label: 'In 3 hours', until: new Date(now.getTime() + 3 * 3_600_000) },
    { label: 'Tomorrow, 9:00', until: at(1, 9) },
    { label: 'Next week (Mon 9:00)', until: at(toMonday, 9) },
  ];
}

/** Inbox (N-02): unread / all / snoozed, filter by type, mark read, clear, snooze. */
export function InboxPage() {
  const [filter, setFilter] = useState<InboxFilter>('unread');
  const [type, setType] = useState('');
  const { data, isLoading } = useInbox(filter, type);
  const items = data?.items ?? [];

  const act = async (path: string, body?: unknown) => {
    await api.post(`/notifications${path}`, body);
    await refreshInbox();
  };

  return (
    <div className="flex h-full flex-col">
      <PageHeader title="Inbox" icon={<Inbox className="size-5 text-muted" />}>
        <Button size="sm" variant="ghost" onClick={() => act('/read-all', type ? { type } : {})}><CheckCheck className="size-4" /> Mark all read</Button>
        <Button size="sm" variant="ghost" onClick={() => act('/clear-read')}><X className="size-4" /> Clear read</Button>
      </PageHeader>
      <div className="flex flex-wrap items-center gap-3 border-b border-app px-5">
        <Tabs<InboxFilter>
          value={filter}
          onChange={setFilter}
          items={[{ value: 'unread', label: 'Unread' }, { value: 'all', label: 'All' }, { value: 'snoozed', label: 'Snoozed' }]}
        />
        <div className="ml-auto py-1.5">
          <Select className="h-7 w-44 text-xs" value={type} onChange={(e) => setType(e.target.value)} aria-label="Filter by type">
            <option value="">All types</option>
            {Object.entries(EVENT_LABELS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
          </Select>
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-3xl px-4 py-4">
          {isLoading ? <Loading /> : !items.length ? (
            <Empty icon={<Inbox className="size-8" />} title={filter === 'unread' ? 'You’re all caught up' : filter === 'snoozed' ? 'Nothing snoozed' : 'No notifications'}>
              {filter === 'unread' ? 'New assignments, mentions and comments show up here.' : null}
            </Empty>
          ) : (
            <div className="divide-y divide-[var(--border)] overflow-hidden rounded-lg border border-app">
              {items.map((n) => <Row key={n.id} n={n} act={act} />)}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function Row({ n, act }: { n: InboxItem; act: (path: string, body?: unknown) => Promise<void> }) {
  const openTask = useOpenTask();
  const nav = useNavigate();
  const unread = !n.readAt;
  const open = () => {
    if (unread) void act(`/${n.id}/read`);
    if (n.redacted) return;
    if (n.task) openTask(n.task.key);
    else if (n.doc) nav(`/docs/${n.doc.id}`);
    else if (n.link?.startsWith('/')) nav(n.link);
    else if (n.link) window.open(n.link, '_blank', 'noopener');
  };
  return (
    <div className={cx('group relative flex gap-3 px-3 py-2.5', unread ? 'bg-app' : 'bg-subtle', !n.redacted && 'hover-bg')}>
      <span className={cx('absolute left-1 top-1/2 size-1.5 -translate-y-1/2 rounded-full', unread ? 'bg-accent-600' : 'bg-transparent')} aria-hidden />
      <div className="relative mt-0.5 shrink-0">
        {n.actor ? <Avatar user={n.actor} size={28} /> : (
          <span className="flex size-7 items-center justify-center rounded-full bg-muted text-muted">{n.doc ? <FileText className="size-4" /> : ICONS[n.eventType] ?? <Inbox className="size-4" />}</span>
        )}
        {n.actor && (
          <span className={cx('absolute -bottom-1 -right-1 flex size-4 items-center justify-center rounded-full border border-app bg-app',
            n.eventType === 'overdue' ? 'text-red-600 dark:text-red-400' : 'text-muted')}>
            {ICONS[n.eventType]}
          </span>
        )}
      </div>
      <button className="min-w-0 flex-1 text-left" onClick={open} disabled={n.redacted}>
        <div className={cx('flex items-center gap-1.5 text-xs', n.eventType === 'overdue' ? 'text-red-600 dark:text-red-400' : 'text-muted')}>
          {!n.actor && ICONS[n.eventType]}
          <span className="truncate">{n.headline}</span>
        </div>
        <div className={cx('truncate text-sm', unread ? 'font-semibold text-app' : 'text-app', n.redacted && 'italic text-muted')}>
          {n.task && <span className="mr-1.5 font-mono text-xs font-normal text-subtle">{n.task.key}</span>}
          {n.task ? n.task.name : n.subject}
        </div>
        {n.body && <div className="mt-0.5 line-clamp-2 text-sm text-muted">{n.body}</div>}
        {n.snoozedUntil && new Date(n.snoozedUntil) > new Date() && (
          <div className="mt-0.5 flex items-center gap-1 text-xs text-subtle"><AlarmClock className="size-3" /> Snoozed until {formatDate(n.snoozedUntil, true)}</div>
        )}
      </button>
      <div className="flex shrink-0 flex-col items-end gap-1">
        <span className="text-xs text-subtle" title={new Date(n.createdAt).toLocaleString()}>{timeAgo(n.createdAt)}</span>
        <div className="flex opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
          {unread
            ? <IconButton size="sm" label="Mark read" onClick={() => act(`/${n.id}/read`)}><Check className="size-3.5" /></IconButton>
            : <IconButton size="sm" label="Mark unread" onClick={() => act(`/${n.id}/unread`)}><MailOpen className="size-3.5" /></IconButton>}
          <Popover align="end" width={200} trigger={(p) => <IconButton {...p} size="sm" label="Snooze"><AlarmClock className="size-3.5" /></IconButton>}>
            {(close) => (
              <>
                <MenuLabel>Snooze until</MenuLabel>
                {snoozeOptions().map((o) => (
                  <MenuItem key={o.label} onClick={() => { close(); void act(`/${n.id}/snooze`, { until: o.until.toISOString() }); }}>{o.label}</MenuItem>
                ))}
                {n.snoozedUntil && <MenuItem icon={<BellOff className="size-4" />} onClick={() => { close(); void act(`/${n.id}/snooze`, { until: null }); }}>Unsnooze</MenuItem>}
              </>
            )}
          </Popover>
          <IconButton size="sm" label="Clear" onClick={() => act(`/${n.id}/clear`)}><X className="size-3.5" /></IconButton>
        </div>
      </div>
    </div>
  );
}
