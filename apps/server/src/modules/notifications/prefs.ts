import { DIGEST_MODES, NOTIFICATION_EVENTS, type DigestMode } from '@app/shared';
import { and, eq } from 'drizzle-orm';
import { db, type Tx } from '../../db/client';
import { notificationPreferences, workspaces } from '../../db/schema';

/** Event types a user can configure. `admin_alert` (notifyAdmins) is only shown to admins. */
export const PREF_EVENTS = [...NOTIFICATION_EVENTS, 'admin_alert'] as const;
export type PrefEvent = (typeof PREF_EVENTS)[number];
export const PREF_CHANNELS = ['in_app', 'email'] as const;
export type PrefChannel = (typeof PREF_CHANNELS)[number];

export interface ChannelPref {
  enabled: boolean;
  digest: DigestMode;
}
export type PrefMatrix = Record<string, Record<PrefChannel, ChannelPref>>;

/** Built-in defaults: in-app on for everything; email instant for assigned + mentioned (+ admin alerts), off otherwise. */
export function builtinDefaults(): PrefMatrix {
  const out: PrefMatrix = {};
  for (const e of PREF_EVENTS) {
    out[e] = {
      in_app: { enabled: true, digest: 'instant' },
      email: { enabled: e === 'assigned' || e === 'mentioned' || e === 'admin_alert', digest: 'instant' },
    };
  }
  return out;
}

const isDigest = (v: unknown): v is DigestMode => typeof v === 'string' && (DIGEST_MODES as readonly string[]).includes(v);

/** Normalize a (possibly partial) stored matrix on top of `base`. */
export function mergeMatrix(base: PrefMatrix, raw: unknown): PrefMatrix {
  const out: PrefMatrix = structuredClone(base);
  if (!raw || typeof raw !== 'object') return out;
  for (const [ev, chans] of Object.entries(raw as Record<string, unknown>)) {
    if (!out[ev] || !chans || typeof chans !== 'object') continue;
    for (const ch of PREF_CHANNELS) {
      const v = (chans as Record<string, unknown>)[ch] as Partial<ChannelPref> | undefined;
      if (!v || typeof v !== 'object') continue;
      if (typeof v.enabled === 'boolean') out[ev][ch].enabled = v.enabled;
      if (isDigest(v.digest)) out[ev][ch].digest = v.digest;
    }
  }
  return out;
}

let wsCache: { at: number; matrix: PrefMatrix; tz: string | null } | null = null;
export const invalidateWorkspaceDefaults = () => { wsCache = null; };

/** Workspace defaults (workspaces.settings.notificationDefaults over the built-ins), cached for 30 s. */
export async function workspaceDefaults(tx: Tx = db): Promise<PrefMatrix> {
  if (wsCache && Date.now() - wsCache.at < 30_000) return wsCache.matrix;
  const [ws] = await tx.select({ settings: workspaces.settings }).from(workspaces).limit(1);
  const matrix = mergeMatrix(builtinDefaults(), ws?.settings?.notificationDefaults);
  const tz = typeof ws?.settings?.timezone === 'string' ? ws.settings.timezone : null;
  wsCache = { at: Date.now(), matrix, tz };
  return matrix;
}

export async function workspaceTimezone(): Promise<string | null> {
  await workspaceDefaults();
  return wsCache?.tz ?? null;
}

/** Effective preferences for a user (rows are overrides of the workspace defaults). */
export async function userPrefs(userId: string, tx: Tx = db): Promise<{ matrix: PrefMatrix; overridden: Set<string> }> {
  const matrix = structuredClone(await workspaceDefaults(tx));
  const rows = await tx.select().from(notificationPreferences).where(eq(notificationPreferences.userId, userId));
  const overridden = new Set<string>();
  for (const r of rows) {
    const cell = matrix[r.eventType]?.[r.channel];
    if (!cell) continue;
    cell.enabled = r.enabled;
    cell.digest = r.digest;
    overridden.add(`${r.eventType}:${r.channel}`);
  }
  return { matrix, overridden };
}

export async function prefFor(userId: string, eventType: string, channel: PrefChannel): Promise<ChannelPref> {
  const { matrix } = await userPrefs(userId);
  return matrix[eventType]?.[channel] ?? { enabled: channel === 'in_app', digest: 'instant' };
}

export async function setUserPref(userId: string, eventType: string, channel: PrefChannel, value: ChannelPref | null) {
  const where = and(eq(notificationPreferences.userId, userId), eq(notificationPreferences.eventType, eventType), eq(notificationPreferences.channel, channel));
  if (!value) {
    await db.delete(notificationPreferences).where(where);
    return;
  }
  await db.insert(notificationPreferences).values({ userId, eventType, channel, enabled: value.enabled, digest: value.digest })
    .onConflictDoUpdate({
      target: [notificationPreferences.userId, notificationPreferences.eventType, notificationPreferences.channel],
      set: { enabled: value.enabled, digest: value.digest },
    });
}
