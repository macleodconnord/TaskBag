import { z } from 'zod';
import type { IntegrationKey } from './enums';

/**
 * Integration settings descriptors (architecture §9.0/§9.1). They drive the credentials GUI
 * (forms are generated from these) and the server-side validation of `integrations.config`.
 * Secret fields are stored encrypted in `integration_secrets` and are write-only.
 */
export type IntegrationFieldType = 'text' | 'url' | 'secret' | 'number' | 'select' | 'boolean' | 'list' | 'textarea' | 'time';

export interface IntegrationField {
  name: string;
  label: string;
  type: IntegrationFieldType;
  help?: string;
  placeholder?: string;
  default?: unknown;
  required?: boolean;
  options?: Array<{ value: string; label: string }>;
  /** list fields: element type */
  itemType?: 'string' | 'number';
  min?: number;
  max?: number;
  /** secret fields: the GUI offers a "Generate" button */
  generate?: boolean;
  /** secret fields: the GUI offers an expiry date (drives reminders 30/7/1 days before) */
  expires?: boolean;
}

export interface IntegrationDescriptor {
  key: IntegrationKey;
  name: string;
  description: string;
  fields: IntegrationField[];
  testLabel: string;
}

export const NINJA_REGIONS = {
  us: 'app.ninjarmm.com',
  us2: 'us2.ninjarmm.com',
  eu: 'eu.ninjarmm.com',
  ca: 'ca.ninjarmm.com',
  oc: 'oc.ninjarmm.com',
} as const;
export type NinjaRegion = keyof typeof NINJA_REGIONS;

export const INTEGRATION_DESCRIPTORS: Record<IntegrationKey, IntegrationDescriptor> = {
  entra: {
    key: 'entra',
    name: 'Microsoft Entra ID (SSO)',
    description: 'Single sign-on with OIDC (authorization code + PKCE). Delegated scopes openid profile email only.',
    testLabel: 'Test discovery and client secret',
    fields: [
      { name: 'tenantId', label: 'Tenant ID', type: 'text', required: true, placeholder: '00000000-0000-0000-0000-000000000000' },
      { name: 'clientId', label: 'Client (application) ID', type: 'text', required: true },
      { name: 'clientSecret', label: 'Client secret', type: 'secret', required: true, expires: true, help: 'Entra client secrets expire after at most 24 months. Set the expiry date to get reminders.' },
      { name: 'requiredGroupIds', label: 'Required group object IDs', type: 'list', itemType: 'string', help: 'If set, users must be in at least one of these groups. Leave empty to allow everyone assigned to the enterprise app.' },
      { name: 'defaultRole', label: 'Role for new users', type: 'select', default: 'member', options: [{ value: 'member', label: 'Member' }, { value: 'guest', label: 'Guest' }] },
      { name: 'syncGroups', label: 'Sync group membership from the groups claim', type: 'boolean', default: true },
    ],
  },
  smtp: {
    key: 'smtp',
    name: 'SMTP (email)',
    description: 'Outgoing email for notifications and digests.',
    testLabel: 'Connect and send a test email to me',
    fields: [
      { name: 'host', label: 'Host', type: 'text', required: true, placeholder: 'smtp.corp.example' },
      { name: 'port', label: 'Port', type: 'number', default: 587, min: 1, max: 65535 },
      {
        name: 'secure', label: 'TLS', type: 'select', default: 'starttls',
        options: [{ value: 'none', label: 'None (plain)' }, { value: 'starttls', label: 'STARTTLS' }, { value: 'tls', label: 'TLS (implicit, port 465)' }],
      },
      { name: 'username', label: 'Username', type: 'text', help: 'Leave empty for an unauthenticated relay.' },
      { name: 'password', label: 'Password', type: 'secret', expires: true },
      { name: 'from', label: 'From address', type: 'text', required: true, placeholder: 'pm@corp.example' },
      { name: 'fromName', label: 'From name', type: 'text', default: 'Project' },
    ],
  },
  gitea: {
    key: 'gitea',
    name: 'Gitea',
    description: 'Links commits, branches and pull requests to tasks; create branches and issues from a task.',
    testLabel: 'Test API token and list repositories',
    fields: [
      { name: 'baseUrl', label: 'Base URL', type: 'url', required: true, placeholder: 'https://gitea.corp.example' },
      { name: 'apiToken', label: 'API token', type: 'secret', expires: true, help: 'Needs read:user, write:repository and write:issue.' },
      { name: 'webhookSecret', label: 'Webhook secret', type: 'secret', generate: true, help: 'Paste the same secret into the Gitea webhook settings (content type application/json).' },
      { name: 'repos', label: 'Repositories', type: 'list', itemType: 'string', placeholder: 'owner/name', help: 'Repositories offered for "Create branch" / "Create issue". Webhooks from any repository are accepted.' },
      { name: 'branchTemplate', label: 'Default branch name', type: 'text', default: 'feat/{key}-{slug}', help: 'Placeholders: {key}, {slug}, {shortId}' },
    ],
  },
  ninjaone: {
    key: 'ninjaone',
    name: 'NinjaOne (read-only)',
    description: 'Polls NinjaOne ticket boards and mirrors tickets into Lists. Never writes to NinjaOne.',
    testLabel: 'Fetch token, list boards, run the delta board',
    fields: [
      {
        name: 'region', label: 'Region', type: 'select', default: 'us',
        options: Object.entries(NINJA_REGIONS).map(([value, host]) => ({ value, label: `${value.toUpperCase()} (${host})` })),
        help: 'Match the host in your NinjaOne login URL.',
      },
      { name: 'clientId', label: 'Client ID', type: 'text', required: true, help: 'API Services (machine-to-machine) app with the monitoring scope.' },
      { name: 'clientSecret', label: 'Client secret', type: 'secret', expires: true },
      { name: 'deltaBoardId', label: 'Delta board ID', type: 'number', help: 'A board whose condition is "updated in the last 24 hours". Polled every poll interval.' },
      { name: 'sourceBoardIds', label: 'Source board IDs', type: 'list', itemType: 'number', help: 'Full boards used by reconcile and the initial backfill.' },
      { name: 'pollIntervalSec', label: 'Poll interval (seconds)', type: 'number', default: 120, min: 30, max: 3600 },
      { name: 'reconcileCron', label: 'Nightly reconcile', type: 'text', default: '0 2 * * *', help: 'Daily at a fixed time: "M H * * *" or "HH:MM" (server time).' },
      { name: 'reconcileIfStaleHours', label: 'Reconcile at startup if last poll is older than (hours)', type: 'number', default: 20, min: 1, max: 23, help: 'Must stay below 24, the delta board window.' },
    ],
  },
  clickup: {
    key: 'clickup',
    name: 'ClickUp (import)',
    description: 'Used by the ClickUp importer. Business plan: 100 requests/min per token.',
    testLabel: 'Test token and show rate limits',
    fields: [
      { name: 'apiToken', label: 'API token', type: 'secret', expires: true },
      { name: 'teamId', label: 'Workspace (team) ID', type: 'text' },
    ],
  },
};

export const secretFieldsOf = (key: IntegrationKey) => INTEGRATION_DESCRIPTORS[key].fields.filter((f) => f.type === 'secret').map((f) => f.name);

/** Zod schema for the non-secret config of an integration (unknown keys are dropped). Empty values become undefined. */
export function integrationConfigSchema(key: IntegrationKey) {
  const shape: Record<string, z.ZodType> = {};
  const blank = (v: unknown) => (v === '' || v === null ? undefined : v);
  for (const f of INTEGRATION_DESCRIPTORS[key].fields) {
    if (f.type === 'secret') continue;
    let s: z.ZodType;
    switch (f.type) {
      case 'number': {
        let n = z.coerce.number();
        if (f.min !== undefined) n = n.min(f.min);
        if (f.max !== undefined) n = n.max(f.max);
        s = z.preprocess(blank, n.optional());
        break;
      }
      case 'boolean': s = z.boolean().optional(); break;
      case 'select': s = z.preprocess(blank, z.enum((f.options ?? []).map((o) => o.value) as [string, ...string[]]).optional()); break;
      case 'list':
        s = f.itemType === 'number'
          ? z.array(z.coerce.number().int()).optional()
          : z.array(z.string().trim().min(1).max(500)).optional();
        break;
      case 'url': s = z.preprocess(blank, z.string().trim().url().max(500).optional()); break;
      default: s = z.preprocess(blank, z.string().trim().max(5000).optional());
    }
    shape[f.name] = s;
  }
  return z.object(shape);
}

/** Outbound webhook event types (the domain events) plus the "send test" event. */
export const WEBHOOK_EVENT_TYPES = [
  'task.created', 'task.updated', 'task.deleted', 'task.assigned', 'comment.created', 'external.event',
] as const;
export type WebhookEventType = (typeof WEBHOOK_EVENT_TYPES)[number];

export const webhookSubscriptionSchema = z.object({
  name: z.string().trim().min(1).max(200),
  url: z.string().trim().url().max(2000),
  eventTypes: z.array(z.enum(WEBHOOK_EVENT_TYPES)).default([]),
  scopeType: z.enum(['workspace', 'space', 'folder', 'list']).default('workspace'),
  scopeId: z.string().uuid().nullable().optional(),
  actingUserId: z.string().uuid(),
  enabled: z.boolean().default(true),
});
export type WebhookSubscriptionInput = z.infer<typeof webhookSubscriptionSchema>;

export const ninjaMappingSchema = z.object({
  name: z.string().trim().min(1).max(200),
  boardIds: z.array(z.coerce.number().int()).default([]),
  targetListId: z.string().uuid(),
  filters: z.object({
    orgIds: z.array(z.coerce.number().int()).optional(),
    statuses: z.array(z.string().min(1)).optional(),
    priorities: z.array(z.string().min(1)).optional(),
    formIds: z.array(z.coerce.number().int()).optional(),
  }).default({}),
  statusMap: z.record(z.string(), z.string().uuid()).default({}),
  fieldMap: z.record(z.string(), z.string().uuid()).default({}),
  syncComments: z.boolean().default(true),
  enabled: z.boolean().default(true),
  position: z.number().int().default(0),
});
export type NinjaMappingInput = z.infer<typeof ninjaMappingSchema>;
