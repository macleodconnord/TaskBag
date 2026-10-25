import type { IntegrationKey } from '@app/shared';
import { and, eq, sql } from 'drizzle-orm';
import { db } from '../../db/client';
import { integrations, integrationSyncLogs } from '../../db/schema';
import { log } from '../../lib/log';

type Health = 'ok' | 'degraded' | 'down' | 'unknown';

/** Make sure the integrations row exists (health columns live there). */
async function ensureRow(key: IntegrationKey) {
  await db.insert(integrations).values({ key, enabled: false, config: {} }).onConflictDoNothing();
}

export async function setHealth(key: IntegrationKey, health: Health, detail: string | null, success = health === 'ok') {
  await ensureRow(key);
  await db.update(integrations).set({
    health,
    healthDetail: detail?.slice(0, 1000) ?? null,
    ...(success ? { lastSuccessAt: new Date() } : {}),
  }).where(eq(integrations.key, key));
}

/**
 * Run `fn` as an integration job: writes an `integration_sync_logs` row (running → ok/error, with stats)
 * and updates the integration's health. Errors are logged and rethrown.
 */
export async function recordRun<T extends Record<string, unknown> | void>(
  key: IntegrationKey,
  jobName: string,
  fn: () => Promise<T>,
  opts: { quietHealth?: boolean } = {},
): Promise<T> {
  const [row] = await db.insert(integrationSyncLogs).values({ integrationKey: key, jobName, status: 'running' }).returning({ id: integrationSyncLogs.id });
  try {
    const result = await fn();
    await db.update(integrationSyncLogs)
      .set({ status: 'ok', finishedAt: new Date(), stats: (result ?? null) as Record<string, unknown> | null })
      .where(eq(integrationSyncLogs.id, row.id));
    if (!opts.quietHealth) await setHealth(key, 'ok', `${jobName} succeeded`);
    return result;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await db.update(integrationSyncLogs)
      .set({ status: 'error', finishedAt: new Date(), error: message.slice(0, 2000) })
      .where(eq(integrationSyncLogs.id, row.id));
    if (!opts.quietHealth) await setHealth(key, 'down', `${jobName}: ${message}`, false);
    log.warn({ key, jobName, error: message }, 'integration run failed');
    throw err;
  }
}

/** Keep the sync log bounded (polls run every couple of minutes). */
export async function pruneSyncLogs() {
  await db.delete(integrationSyncLogs).where(sql`${integrationSyncLogs.startedAt} < now() - interval '14 days'`);
  // runs stuck in "running" after a crash
  await db.update(integrationSyncLogs).set({ status: 'error', error: 'interrupted', finishedAt: new Date() })
    .where(and(eq(integrationSyncLogs.status, 'running'), sql`${integrationSyncLogs.startedAt} < now() - interval '6 hours'`));
}
