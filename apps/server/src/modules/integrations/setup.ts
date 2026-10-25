import { INTEGRATION_DESCRIPTORS, type IntegrationKey } from '@app/shared';
import { and, eq, isNotNull } from 'drizzle-orm';
import { db } from '../../db/client';
import { integrationSecrets } from '../../db/schema';
import { registerJob } from '../../lib/jobs';
import { log } from '../../lib/log';
import { notifyAdmins } from '../notifications/service';
import { pruneSyncLogs } from './health';

const DAY = 86_400_000;
const THRESHOLDS = [1, 7, 30] as const;

/** Which reminder is due: '1' | '7' | '30' (the smallest threshold reached), or null. */
export function dueReminder(expiresAt: Date, now = new Date()): '1' | '7' | '30' | null {
  const days = (expiresAt.getTime() - now.getTime()) / DAY;
  for (const t of THRESHOLDS) if (days <= t) return String(t) as '1' | '7' | '30';
  return null;
}

/** Daily-ish check: reminders 30, 7 and 1 days before a secret's `expires_at`. */
export async function checkSecretExpiry(now = new Date()) {
  const rows = await db.select().from(integrationSecrets).where(isNotNull(integrationSecrets.expiresAt));
  let sent = 0;
  for (const s of rows) {
    const due = dueReminder(s.expiresAt!, now);
    if (!due) continue;
    // already sent this (or a later, smaller) reminder
    if (s.expiryNotified && Number(s.expiryNotified) <= Number(due)) continue;
    const name = INTEGRATION_DESCRIPTORS[s.integrationKey as IntegrationKey]?.name ?? s.integrationKey;
    const field = INTEGRATION_DESCRIPTORS[s.integrationKey as IntegrationKey]?.fields.find((f) => f.name === s.name)?.label ?? s.name;
    const days = Math.ceil((s.expiresAt!.getTime() - now.getTime()) / DAY);
    const when = s.expiresAt!.toISOString().slice(0, 10);
    const title = days <= 0 ? `${name}: ${field} has expired` : `${name}: ${field} expires in ${days} day${days === 1 ? '' : 's'}`;
    // in-app + email (per the admins' notification preferences), deduped per secret/threshold/expiry date
    await notifyAdmins({
      dedupeKey: `secret-expiry:${s.integrationKey}:${s.name}:${due}d:${when}`,
      title,
      body: `${title} (${when}). Rotate it in Admin → Integrations & credentials.`,
      link: '/admin/integrations',
    });
    await db.update(integrationSecrets).set({ expiryNotified: due })
      .where(and(eq(integrationSecrets.integrationKey, s.integrationKey), eq(integrationSecrets.name, s.name)));
    sent++;
  }
  if (sent) log.info({ sent }, 'integration secret expiry reminders sent');
  return { sent };
}

/** Integrations framework: secret expiry reminders and sync-log housekeeping. */
export async function setup() {
  registerJob('integrations.secret-expiry', 6 * 60 * 60_000, () => checkSecretExpiry());
  registerJob('integrations.prune-logs', 24 * 60 * 60_000, pruneSyncLogs);
}
