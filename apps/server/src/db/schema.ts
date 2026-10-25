import { sql, type SQL } from 'drizzle-orm';
import {
  bigserial, boolean, customType, index, integer, jsonb, pgEnum, pgTable, primaryKey, smallint,
  text, timestamp, uniqueIndex, uuid,
} from 'drizzle-orm/pg-core';

const tsvector = customType<{ data: string }>({ dataType: () => 'tsvector' });

const id = () => uuid('id').primaryKey().default(sql`gen_random_uuid()`);
const ts = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });
const createdAt = () => ts('created_at').notNull().defaultNow();
const updatedAt = () => ts('updated_at').notNull().defaultNow().$onUpdate(() => new Date());

export const workspaceRole = pgEnum('workspace_role', ['owner', 'admin', 'member', 'guest']);
export const permissionLevel = pgEnum('permission_level', ['view', 'comment', 'edit', 'full']);
export const statusGroup = pgEnum('status_group', ['open', 'active', 'done', 'closed']);
export const scopeMode = pgEnum('scope_mode', ['additive', 'override']);

// ───────────────────────── identity ─────────────────────────

export const workspaces = pgTable('workspaces', {
  id: id(),
  name: text('name').notNull(),
  /** { timezone, defaultRole, notificationDefaults, ... } */
  settings: jsonb('settings').$type<Record<string, unknown>>().notNull().default({}),
  createdAt: createdAt(),
});

export const users = pgTable('users', {
  id: id(),
  email: text('email').notNull(),
  displayName: text('display_name').notNull(),
  avatarUrl: text('avatar_url'),
  entraOid: text('entra_oid').unique(),
  role: workspaceRole('role').notNull().default('member'),
  isActive: boolean('is_active').notNull().default(true),
  isSystem: boolean('is_system').notNull().default(false),
  isBreakglass: boolean('is_breakglass').notNull().default(false),
  isPlaceholder: boolean('is_placeholder').notNull().default(false),
  passwordHash: text('password_hash'),
  totpSecretEnc: text('totp_secret_enc'),
  timezone: text('timezone'),
  theme: text('theme').notNull().default('system'),
  lastLoginAt: ts('last_login_at'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [uniqueIndex('users_email_lower').on(sql`lower(${t.email})`)]);

export const groups = pgTable('groups', {
  id: id(),
  name: text('name').notNull(),
  description: text('description'),
  source: text('source').$type<'local' | 'entra'>().notNull().default('local'),
  entraGroupId: text('entra_group_id').unique(),
  isSystem: boolean('is_system').notNull().default(false),
  createdAt: createdAt(),
});

export const groupMembers = pgTable('group_members', {
  groupId: uuid('group_id').notNull().references(() => groups.id, { onDelete: 'cascade' }),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  source: text('source').$type<'local' | 'entra'>().notNull().default('local'),
}, (t) => [primaryKey({ columns: [t.groupId, t.userId] }), index('group_members_user').on(t.userId)]);

export const sessions = pgTable('sessions', {
  /** sha256 of the opaque cookie token */
  id: text('id').primaryKey(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  csrfToken: text('csrf_token').notNull(),
  viaBreakglass: boolean('via_breakglass').notNull().default(false),
  createdAt: createdAt(),
  lastSeenAt: ts('last_seen_at').notNull().defaultNow(),
  expiresAt: ts('expires_at').notNull(),
  ip: text('ip'),
  userAgent: text('user_agent'),
}, (t) => [index('sessions_user').on(t.userId)]);

// ───────────────────────── ACL ─────────────────────────

export const aclScopes = pgTable('acl_scopes', {
  id: id(),
  objectType: text('object_type').$type<'workspace' | 'space' | 'folder' | 'list' | 'task' | 'doc'>().notNull(),
  objectId: uuid('object_id').notNull(),
  parentScopeId: uuid('parent_scope_id'),
  mode: scopeMode('mode').notNull(),
  createdAt: createdAt(),
}, (t) => [uniqueIndex('acl_scopes_object').on(t.objectType, t.objectId)]);

export const aclEntries = pgTable('acl_entries', {
  id: id(),
  scopeId: uuid('scope_id').notNull().references(() => aclScopes.id, { onDelete: 'cascade' }),
  principalType: text('principal_type').$type<'user' | 'group'>().notNull(),
  principalId: uuid('principal_id').notNull(),
  level: permissionLevel('level').notNull(),
  grantedBy: uuid('granted_by'),
  grantedAt: createdAt(),
}, (t) => [uniqueIndex('acl_entries_unique').on(t.scopeId, t.principalType, t.principalId)]);

// ───────────────────────── hierarchy ─────────────────────────

export const statusSets = pgTable('status_sets', {
  id: id(),
  ownerType: text('owner_type').$type<'space' | 'list'>().notNull(),
  ownerId: uuid('owner_id').notNull(),
});

export const statuses = pgTable('statuses', {
  id: id(),
  statusSetId: uuid('status_set_id').notNull().references(() => statusSets.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  color: text('color').notNull(),
  group: statusGroup('group').notNull(),
  position: integer('position').notNull().default(0),
}, (t) => [index('statuses_set').on(t.statusSetId)]);

export const spaces = pgTable('spaces', {
  id: id(),
  workspaceId: uuid('workspace_id').notNull().references(() => workspaces.id),
  name: text('name').notNull(),
  keyPrefix: text('key_prefix').notNull().unique(),
  color: text('color'),
  statusSetId: uuid('status_set_id'),
  taskSeq: integer('task_seq').notNull().default(0),
  position: integer('position').notNull().default(0),
  aclScopeId: uuid('acl_scope_id').notNull(),
  archivedAt: ts('archived_at'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const folders = pgTable('folders', {
  id: id(),
  spaceId: uuid('space_id').notNull().references(() => spaces.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  position: integer('position').notNull().default(0),
  aclScopeId: uuid('acl_scope_id').notNull(),
  archivedAt: ts('archived_at'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [index('folders_space').on(t.spaceId)]);

export interface ListSettings {
  /** Gitea: when a linked PR merges, move the task to this status */
  giteaPrMergedStatusId?: string | null;
}

export const lists = pgTable('lists', {
  id: id(),
  spaceId: uuid('space_id').notNull().references(() => spaces.id, { onDelete: 'cascade' }),
  folderId: uuid('folder_id').references(() => folders.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  description: jsonb('description'),
  statusSetId: uuid('status_set_id'),
  settings: jsonb('settings').$type<ListSettings>().notNull().default({}),
  position: integer('position').notNull().default(0),
  aclScopeId: uuid('acl_scope_id').notNull(),
  archivedAt: ts('archived_at'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [index('lists_space').on(t.spaceId), index('lists_folder').on(t.folderId)]);

// ───────────────────────── tasks ─────────────────────────

export const tasks = pgTable('tasks', {
  id: id(),
  workspaceId: uuid('workspace_id').notNull().references(() => workspaces.id),
  listId: uuid('list_id').notNull().references(() => lists.id, { onDelete: 'cascade' }),
  parentTaskId: uuid('parent_task_id'),
  key: text('key').notNull().unique(),
  shortId: text('short_id').notNull().unique(),
  seq: integer('seq').notNull(),
  name: text('name').notNull(),
  description: jsonb('description'),
  descriptionText: text('description_text').notNull().default(''),
  statusId: uuid('status_id').notNull(),
  priority: smallint('priority'),
  startAt: ts('start_at'),
  dueAt: ts('due_at'),
  dueHasTime: boolean('due_has_time').notNull().default(false),
  timeEstimateMin: integer('time_estimate_min'),
  position: text('position').notNull(),
  aclScopeId: uuid('acl_scope_id').notNull(),
  createdBy: uuid('created_by'),
  archivedAt: ts('archived_at'),
  deletedAt: ts('deleted_at'),
  completedAt: ts('completed_at'),
  source: text('source').$type<'app' | 'clickup' | 'ninjaone'>().notNull().default('app'),
  /** last due-date notification sent: 'soon' | 'overdue' (reset when due_at changes) */
  dueNotified: text('due_notified'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
  search: tsvector('search').generatedAlwaysAs(
    (): SQL => sql`setweight(to_tsvector('simple', coalesce(${tasks.name}, '') || ' ' || coalesce(${tasks.key}, '')), 'A') || setweight(to_tsvector('simple', coalesce(${tasks.descriptionText}, '')), 'B')`,
  ),
}, (t) => [
  index('tasks_list').on(t.listId, t.position),
  index('tasks_parent').on(t.parentTaskId),
  index('tasks_scope').on(t.aclScopeId),
  index('tasks_due').on(t.dueAt).where(sql`archived_at is null and completed_at is null and deleted_at is null`),
  index('tasks_search').using('gin', t.search),
]);

export const taskAssignees = pgTable('task_assignees', {
  taskId: uuid('task_id').notNull().references(() => tasks.id, { onDelete: 'cascade' }),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  assignedAt: createdAt(),
}, (t) => [primaryKey({ columns: [t.taskId, t.userId] }), index('task_assignees_user').on(t.userId)]);

export const tags = pgTable('tags', {
  id: id(),
  spaceId: uuid('space_id').notNull().references(() => spaces.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  color: text('color').notNull().default('#64748b'),
}, (t) => [uniqueIndex('tags_space_name').on(t.spaceId, sql`lower(${t.name})`)]);

export const taskTags = pgTable('task_tags', {
  taskId: uuid('task_id').notNull().references(() => tasks.id, { onDelete: 'cascade' }),
  tagId: uuid('tag_id').notNull().references(() => tags.id, { onDelete: 'cascade' }),
}, (t) => [primaryKey({ columns: [t.taskId, t.tagId] })]);

export const checklists = pgTable('checklists', {
  id: id(),
  taskId: uuid('task_id').notNull().references(() => tasks.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  position: integer('position').notNull().default(0),
}, (t) => [index('checklists_task').on(t.taskId)]);

export const checklistItems = pgTable('checklist_items', {
  id: id(),
  checklistId: uuid('checklist_id').notNull().references(() => checklists.id, { onDelete: 'cascade' }),
  parentItemId: uuid('parent_item_id'),
  name: text('name').notNull(),
  assigneeId: uuid('assignee_id').references(() => users.id, { onDelete: 'set null' }),
  resolved: boolean('resolved').notNull().default(false),
  position: integer('position').notNull().default(0),
}, (t) => [index('checklist_items_list').on(t.checklistId)]);

export const taskDependencies = pgTable('task_dependencies', {
  /** the waiting task */
  taskId: uuid('task_id').notNull().references(() => tasks.id, { onDelete: 'cascade' }),
  /** the blocking task */
  dependsOnTaskId: uuid('depends_on_task_id').notNull().references(() => tasks.id, { onDelete: 'cascade' }),
}, (t) => [primaryKey({ columns: [t.taskId, t.dependsOnTaskId] }), index('task_deps_blocking').on(t.dependsOnTaskId)]);

export const taskLinks = pgTable('task_links', {
  taskAId: uuid('task_a_id').notNull().references(() => tasks.id, { onDelete: 'cascade' }),
  taskBId: uuid('task_b_id').notNull().references(() => tasks.id, { onDelete: 'cascade' }),
  createdBy: uuid('created_by'),
}, (t) => [primaryKey({ columns: [t.taskAId, t.taskBId] }), index('task_links_b').on(t.taskBId)]);

/** List ↔ Task parent link (1:1): the task "owns" the linked list and shows its rollup. */
export const listTaskLinks = pgTable('list_task_links', {
  id: id(),
  taskId: uuid('task_id').notNull().unique().references(() => tasks.id, { onDelete: 'cascade' }),
  listId: uuid('list_id').notNull().unique().references(() => lists.id, { onDelete: 'cascade' }),
  createdBy: uuid('created_by'),
  createdAt: createdAt(),
});

export const comments = pgTable('comments', {
  id: id(),
  taskId: uuid('task_id').references(() => tasks.id, { onDelete: 'cascade' }),
  docId: uuid('doc_id'),
  parentId: uuid('parent_id'),
  authorId: uuid('author_id').notNull(),
  body: jsonb('body').notNull(),
  bodyText: text('body_text').notNull().default(''),
  editedAt: ts('edited_at'),
  deletedAt: ts('deleted_at'),
  /** e.g. `ninjaone:<logEntryId>` or `clickup:<commentId>` for dedupe */
  sourceExternal: text('source_external').unique(),
  createdAt: createdAt(),
  search: tsvector('search').generatedAlwaysAs((): SQL => sql`to_tsvector('simple', coalesce(${comments.bodyText}, ''))`),
}, (t) => [
  index('comments_task').on(t.taskId, t.createdAt),
  index('comments_doc').on(t.docId, t.createdAt),
  index('comments_search').using('gin', t.search),
]);

export const attachments = pgTable('attachments', {
  id: id(),
  taskId: uuid('task_id').references(() => tasks.id, { onDelete: 'cascade' }),
  commentId: uuid('comment_id'),
  docId: uuid('doc_id'),
  uploaderId: uuid('uploader_id').notNull(),
  filename: text('filename').notNull(),
  contentType: text('content_type').notNull(),
  sizeBytes: integer('size_bytes').notNull(),
  storageKey: text('storage_key').notNull(),
  sha256: text('sha256').notNull(),
  createdAt: createdAt(),
  deletedAt: ts('deleted_at'),
}, (t) => [index('attachments_task').on(t.taskId), index('attachments_doc').on(t.docId)]);

// ───────────────────────── custom fields, views, templates ─────────────────────────

export const customFields = pgTable('custom_fields', {
  id: id(),
  name: text('name').notNull(),
  type: text('type').notNull(),
  /** { options:[{id,name,color}], currency, precision, max, targetListId, expression } */
  config: jsonb('config').$type<Record<string, unknown>>().notNull().default({}),
  scopeType: text('scope_type').$type<'space' | 'folder' | 'list'>().notNull(),
  scopeId: uuid('scope_id').notNull(),
  required: boolean('required').notNull().default(false),
  position: integer('position').notNull().default(0),
  archivedAt: ts('archived_at'),
  createdAt: createdAt(),
}, (t) => [index('custom_fields_scope').on(t.scopeType, t.scopeId)]);

export const taskFieldValues = pgTable('task_field_values', {
  taskId: uuid('task_id').notNull().references(() => tasks.id, { onDelete: 'cascade' }),
  fieldId: uuid('field_id').notNull().references(() => customFields.id, { onDelete: 'cascade' }),
  value: jsonb('value'),
  updatedAt: updatedAt(),
  updatedBy: uuid('updated_by'),
}, (t) => [primaryKey({ columns: [t.taskId, t.fieldId] }), index('tfv_field').on(t.fieldId)]);

export const views = pgTable('views', {
  id: id(),
  scopeType: text('scope_type').$type<'space' | 'folder' | 'list' | 'everything'>().notNull(),
  scopeId: uuid('scope_id'),
  type: text('type').$type<'list' | 'board' | 'table' | 'calendar' | 'gantt'>().notNull(),
  name: text('name').notNull(),
  visibility: text('visibility').$type<'personal' | 'shared'>().notNull().default('shared'),
  ownerId: uuid('owner_id').notNull(),
  config: jsonb('config').$type<Record<string, unknown>>().notNull().default({}),
  position: integer('position').notNull().default(0),
  isDefault: boolean('is_default').notNull().default(false),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [index('views_scope').on(t.scopeType, t.scopeId)]);

export const templates = pgTable('templates', {
  id: id(),
  kind: text('kind').$type<'task' | 'list'>().notNull(),
  name: text('name').notNull(),
  description: text('description'),
  payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
  createdBy: uuid('created_by').notNull(),
  createdAt: createdAt(),
});

// ───────────────────────── notifications ─────────────────────────

export const notifications = pgTable('notifications', {
  id: id(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  eventType: text('event_type').notNull(),
  taskId: uuid('task_id').references(() => tasks.id, { onDelete: 'cascade' }),
  docId: uuid('doc_id'),
  commentId: uuid('comment_id'),
  actorId: uuid('actor_id'),
  /** minimal; title etc. are re-read with an ACL check when rendered */
  payload: jsonb('payload').$type<Record<string, unknown>>().notNull().default({}),
  dedupeKey: text('dedupe_key').notNull().unique(),
  readAt: ts('read_at'),
  clearedAt: ts('cleared_at'),
  snoozedUntil: ts('snoozed_until'),
  /** set when an email (instant or digest) covered this notification */
  emailedAt: ts('emailed_at'),
  createdAt: createdAt(),
}, (t) => [index('notifications_inbox').on(t.userId, t.clearedAt, t.createdAt)]);

export const notificationPreferences = pgTable('notification_preferences', {
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  eventType: text('event_type').notNull(),
  channel: text('channel').$type<'in_app' | 'email'>().notNull(),
  enabled: boolean('enabled').notNull(),
  digest: text('digest').$type<'instant' | 'hourly' | 'daily'>().notNull().default('instant'),
}, (t) => [primaryKey({ columns: [t.userId, t.eventType, t.channel] })]);

export const emailOutbox = pgTable('email_outbox', {
  id: id(),
  userId: uuid('user_id'),
  toAddress: text('to_address').notNull(),
  subject: text('subject').notNull(),
  html: text('html').notNull(),
  text: text('text').notNull(),
  status: text('status').$type<'pending' | 'sent' | 'failed'>().notNull().default('pending'),
  attempts: integer('attempts').notNull().default(0),
  nextAttemptAt: ts('next_attempt_at').notNull().defaultNow(),
  lastError: text('last_error'),
  createdAt: createdAt(),
  sentAt: ts('sent_at'),
}, (t) => [index('email_outbox_pending').on(t.status, t.nextAttemptAt)]);

// ───────────────────────── docs ─────────────────────────

export const docs = pgTable('docs', {
  id: id(),
  workspaceId: uuid('workspace_id').notNull().references(() => workspaces.id),
  parentDocId: uuid('parent_doc_id'),
  containerType: text('container_type').$type<'space' | 'folder' | 'list'>().notNull(),
  containerId: uuid('container_id').notNull(),
  title: text('title').notNull(),
  content: jsonb('content'),
  contentText: text('content_text').notNull().default(''),
  aclScopeId: uuid('acl_scope_id').notNull(),
  position: integer('position').notNull().default(0),
  createdBy: uuid('created_by').notNull(),
  updatedBy: uuid('updated_by'),
  archivedAt: ts('archived_at'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
  search: tsvector('search').generatedAlwaysAs(
    (): SQL => sql`setweight(to_tsvector('simple', coalesce(${docs.title}, '')), 'A') || setweight(to_tsvector('simple', coalesce(${docs.contentText}, '')), 'B')`,
  ),
}, (t) => [
  index('docs_container').on(t.containerType, t.containerId),
  index('docs_parent').on(t.parentDocId),
  index('docs_scope').on(t.aclScopeId),
  index('docs_search').using('gin', t.search),
]);

export const docRevisions = pgTable('doc_revisions', {
  id: id(),
  docId: uuid('doc_id').notNull().references(() => docs.id, { onDelete: 'cascade' }),
  title: text('title').notNull(),
  content: jsonb('content'),
  authorId: uuid('author_id'),
  createdAt: createdAt(),
}, (t) => [index('doc_revisions_doc').on(t.docId, t.createdAt)]);

// ───────────────────────── integrations ─────────────────────────

export const integrations = pgTable('integrations', {
  key: text('key').primaryKey(),
  enabled: boolean('enabled').notNull().default(false),
  config: jsonb('config').$type<Record<string, unknown>>().notNull().default({}),
  health: text('health').$type<'ok' | 'degraded' | 'down' | 'unknown'>().notNull().default('unknown'),
  healthDetail: text('health_detail'),
  lastSuccessAt: ts('last_success_at'),
  updatedBy: uuid('updated_by'),
  updatedAt: updatedAt(),
});

export const integrationSecrets = pgTable('integration_secrets', {
  integrationKey: text('integration_key').notNull(),
  name: text('name').notNull(),
  /** base64 iv.tag.ciphertext (AES-256-GCM, key from APP_ENCRYPTION_KEY) */
  valueEnc: text('value_enc').notNull(),
  expiresAt: ts('expires_at'),
  /** last expiry reminder sent: '30' | '7' | '1' */
  expiryNotified: text('expiry_notified'),
  updatedBy: uuid('updated_by'),
  updatedAt: updatedAt(),
}, (t) => [primaryKey({ columns: [t.integrationKey, t.name] })]);

export const integrationSyncLogs = pgTable('integration_sync_logs', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  integrationKey: text('integration_key').notNull(),
  jobName: text('job_name').notNull(),
  status: text('status').$type<'running' | 'ok' | 'error'>().notNull(),
  startedAt: createdAt(),
  finishedAt: ts('finished_at'),
  stats: jsonb('stats').$type<Record<string, unknown>>(),
  error: text('error'),
}, (t) => [index('sync_logs_key').on(t.integrationKey, t.startedAt)]);

export const giteaLinks = pgTable('gitea_links', {
  id: id(),
  taskId: uuid('task_id').notNull().references(() => tasks.id, { onDelete: 'cascade' }),
  repo: text('repo').notNull(),
  kind: text('kind').$type<'commit' | 'branch' | 'pr' | 'issue'>().notNull(),
  ref: text('ref').notNull(),
  title: text('title'),
  url: text('url'),
  author: text('author'),
  state: text('state'),
  occurredAt: ts('occurred_at').notNull().defaultNow(),
}, (t) => [uniqueIndex('gitea_links_unique').on(t.taskId, t.repo, t.kind, t.ref)]);

export const ninjaBoardMappings = pgTable('ninja_board_mappings', {
  id: id(),
  name: text('name').notNull(),
  /** only tickets from these boards; empty = any board polled */
  boardIds: jsonb('board_ids').$type<number[]>().notNull().default([]),
  targetListId: uuid('target_list_id').notNull().references(() => lists.id, { onDelete: 'cascade' }),
  /** { orgIds?: number[], statuses?: string[], priorities?: string[], formIds?: number[] } */
  filters: jsonb('filters').$type<Record<string, unknown>>().notNull().default({}),
  /** ninja status name → our status id */
  statusMap: jsonb('status_map').$type<Record<string, string>>().notNull().default({}),
  /** ninja field path → custom field id */
  fieldMap: jsonb('field_map').$type<Record<string, string>>().notNull().default({}),
  syncComments: boolean('sync_comments').notNull().default(true),
  enabled: boolean('enabled').notNull().default(true),
  position: integer('position').notNull().default(0),
  createdAt: createdAt(),
});

export const ninjaTickets = pgTable('ninja_tickets', {
  ticketId: integer('ticket_id').primaryKey(),
  boardId: integer('board_id'),
  taskId: uuid('task_id').unique().references(() => tasks.id, { onDelete: 'set null' }),
  snapshot: jsonb('snapshot').notNull(),
  snapshotHash: text('snapshot_hash').notNull(),
  lastPolledAt: ts('last_polled_at').notNull().defaultNow(),
  lastLogEntryId: text('last_log_entry_id'),
});

export const ninjaSyncState = pgTable('ninja_sync_state', {
  id: integer('id').primaryKey().default(1),
  lastSuccessfulPollAt: ts('last_successful_poll_at'),
  lastReconcileAt: ts('last_reconcile_at'),
  lastReconcileStatus: text('last_reconcile_status'),
  lastReconcileStats: jsonb('last_reconcile_stats'),
  reconcileRunning: boolean('reconcile_running').notNull().default(false),
});

export const webhookSubscriptions = pgTable('webhook_subscriptions', {
  id: id(),
  name: text('name').notNull(),
  url: text('url').notNull(),
  secretEnc: text('secret_enc').notNull(),
  eventTypes: jsonb('event_types').$type<string[]>().notNull().default([]),
  scopeType: text('scope_type').$type<'workspace' | 'space' | 'folder' | 'list'>().notNull().default('workspace'),
  scopeId: uuid('scope_id'),
  /** payloads are filtered to what this user can view */
  actingUserId: uuid('acting_user_id').notNull(),
  enabled: boolean('enabled').notNull().default(true),
  createdAt: createdAt(),
});

export const webhookDeliveries = pgTable('webhook_deliveries', {
  id: id(),
  subscriptionId: uuid('subscription_id').notNull().references(() => webhookSubscriptions.id, { onDelete: 'cascade' }),
  eventId: text('event_id').notNull(),
  eventType: text('event_type').notNull(),
  payload: jsonb('payload').notNull(),
  status: text('status').$type<'pending' | 'succeeded' | 'failed'>().notNull().default('pending'),
  httpStatus: integer('http_status'),
  attempts: integer('attempts').notNull().default(0),
  nextAttemptAt: ts('next_attempt_at').notNull().defaultNow(),
  responseExcerpt: text('response_excerpt'),
  createdAt: createdAt(),
}, (t) => [
  uniqueIndex('webhook_deliveries_unique').on(t.subscriptionId, t.eventId),
  index('webhook_deliveries_pending').on(t.status, t.nextAttemptAt),
]);

// ───────────────────────── ClickUp import ─────────────────────────

export const importRuns = pgTable('import_runs', {
  id: id(),
  source: text('source').notNull().default('clickup'),
  mode: text('mode').$type<'dry_run' | 'full' | 'delta'>().notNull(),
  status: text('status').$type<'queued' | 'running' | 'paused' | 'cancelled' | 'succeeded' | 'failed'>().notNull().default('queued'),
  startedBy: uuid('started_by'),
  startedAt: ts('started_at'),
  finishedAt: ts('finished_at'),
  /** resume checkpoint: { stage, spaceIdx, listIdx, page, ... } */
  cursor: jsonb('cursor').$type<Record<string, unknown>>().notNull().default({}),
  since: ts('since'),
  /** per entity: { seen, created, updated, skipped } */
  stats: jsonb('stats').$type<Record<string, Record<string, number>>>().notNull().default({}),
  error: text('error'),
  createdAt: createdAt(),
});

export const externalIds = pgTable('external_ids', {
  source: text('source').notNull(),
  entity: text('entity').notNull(),
  externalId: text('external_id').notNull(),
  internalId: uuid('internal_id').notNull(),
  importRunId: uuid('import_run_id'),
  checksum: text('checksum'),
}, (t) => [
  primaryKey({ columns: [t.source, t.entity, t.externalId] }),
  uniqueIndex('external_ids_internal').on(t.source, t.entity, t.internalId),
]);

export const importUserMappings = pgTable('import_user_mappings', {
  clickupUserId: text('clickup_user_id').primaryKey(),
  clickupEmail: text('clickup_email'),
  clickupName: text('clickup_name'),
  userId: uuid('user_id'),
  resolution: text('resolution').$type<'auto_email' | 'manual' | 'placeholder' | 'skip' | 'unresolved'>().notNull().default('unresolved'),
});

export const importIssues = pgTable('import_issues', {
  id: id(),
  importRunId: uuid('import_run_id').notNull().references(() => importRuns.id, { onDelete: 'cascade' }),
  severity: text('severity').$type<'info' | 'warn' | 'error'>().notNull(),
  entity: text('entity').notNull(),
  externalId: text('external_id'),
  message: text('message').notNull(),
  createdAt: createdAt(),
}, (t) => [index('import_issues_run').on(t.importRunId)]);
