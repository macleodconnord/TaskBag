import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { POLL_FAST, POLL_SLOW, queryClient } from '@/lib/queries';

export interface InboxItem {
  id: string;
  eventType: string;
  createdAt: string;
  readAt: string | null;
  snoozedUntil: string | null;
  redacted: boolean;
  actor: { id: string; displayName: string; avatarUrl: string | null } | null;
  task: { id: string; key: string; name: string; status: { name: string; color: string } | null; completed: boolean } | null;
  doc: { id: string; title: string } | null;
  headline: string;
  subject: string;
  body: string | null;
  link: string | null;
}

export type InboxFilter = 'unread' | 'all' | 'snoozed';
export type Digest = 'instant' | 'hourly' | 'daily';
export type Cell = { enabled: boolean; digest: Digest; overridden?: boolean };
export interface Prefs {
  events: string[];
  channels: Array<'in_app' | 'email'>;
  matrix: Record<string, Record<'in_app' | 'email', Cell>>;
  defaults: Record<string, Record<'in_app' | 'email', Cell>>;
  isAdmin: boolean;
}

export const EVENT_LABELS: Record<string, { label: string; hint: string }> = {
  assigned: { label: 'Assigned to me', hint: 'Someone assigns you a task' },
  mentioned: { label: 'Mentions', hint: '@mentions in comments and docs' },
  commented: { label: 'Comments', hint: 'New comments on tasks you’re assigned to or created' },
  status_changed: { label: 'Status changes', hint: 'Tasks you’re assigned to or created' },
  due_soon: { label: 'Due soon', hint: 'Your tasks due today or tomorrow (or within 24 h)' },
  overdue: { label: 'Overdue', hint: 'Your tasks past their due date' },
  admin_alert: { label: 'Admin alerts', hint: 'Integration problems, expiring secrets' },
};

export const nkeys = {
  all: ['notifications'] as const,
  list: (filter: InboxFilter, type: string) => ['notifications', 'list', filter, type] as const,
  count: ['notifications', 'count'] as const,
  prefs: ['notifications', 'prefs'] as const,
};

export const refreshInbox = () => queryClient.invalidateQueries({ queryKey: nkeys.all });

export const useInbox = (filter: InboxFilter, type: string) =>
  useQuery({
    queryKey: nkeys.list(filter, type),
    queryFn: () => api.get<{ items: InboxItem[]; hasMore: boolean }>(`/notifications?filter=${filter}&limit=100${type ? `&type=${type}` : ''}`),
    refetchInterval: POLL_FAST,
  });

export const useUnreadCount = () =>
  useQuery({ queryKey: nkeys.count, queryFn: () => api.get<{ count: number }>('/notifications/unread-count'), refetchInterval: POLL_SLOW });

export const usePrefs = () => useQuery({ queryKey: nkeys.prefs, queryFn: () => api.get<Prefs>('/notifications/preferences') });
