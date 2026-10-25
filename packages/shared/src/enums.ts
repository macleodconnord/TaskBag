export const WORKSPACE_ROLES = ['owner', 'admin', 'member', 'guest'] as const;
export type WorkspaceRole = (typeof WORKSPACE_ROLES)[number];

export const LEVELS = ['none', 'view', 'comment', 'edit', 'full'] as const;
export type Level = (typeof LEVELS)[number];
export type GrantLevel = Exclude<Level, 'none'>;
export const GRANT_LEVELS: GrantLevel[] = ['view', 'comment', 'edit', 'full'];

export const STATUS_GROUPS = ['open', 'active', 'done', 'closed'] as const;
export type StatusGroup = (typeof STATUS_GROUPS)[number];

export const OBJECT_TYPES = ['workspace', 'space', 'folder', 'list', 'task', 'doc'] as const;
export type ObjectType = (typeof OBJECT_TYPES)[number];

export const SCOPE_MODES = ['additive', 'override'] as const;
export type ScopeMode = (typeof SCOPE_MODES)[number];

export const PRIORITIES = [
  { value: 1, label: 'Urgent', color: '#dc2626' },
  { value: 2, label: 'High', color: '#ea580c' },
  { value: 3, label: 'Normal', color: '#2563eb' },
  { value: 4, label: 'Low', color: '#64748b' },
] as const;

export const FIELD_TYPES = [
  'text', 'number', 'currency', 'dropdown', 'labels', 'date', 'checkbox',
  'user', 'url', 'email', 'phone', 'rating', 'progress', 'relationship', 'formula',
] as const;
export type FieldType = (typeof FIELD_TYPES)[number];

export const VIEW_TYPES = ['list', 'board', 'table', 'calendar', 'gantt'] as const;
export type ViewType = (typeof VIEW_TYPES)[number];

export const NOTIFICATION_EVENTS = [
  'assigned', 'mentioned', 'commented', 'status_changed', 'due_soon', 'overdue',
] as const;
export type NotificationEvent = (typeof NOTIFICATION_EVENTS)[number];
export const NOTIFICATION_CHANNELS = ['in_app', 'email'] as const;
export type NotificationChannel = (typeof NOTIFICATION_CHANNELS)[number];
export const DIGEST_MODES = ['instant', 'hourly', 'daily'] as const;
export type DigestMode = (typeof DIGEST_MODES)[number];

export const INTEGRATION_KEYS = ['entra', 'smtp', 'gitea', 'ninjaone', 'clickup'] as const;
export type IntegrationKey = (typeof INTEGRATION_KEYS)[number];
