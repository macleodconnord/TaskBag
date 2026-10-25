import { eq } from 'drizzle-orm';
import { ninjaTickets } from '../../db/schema';
import { env } from '../../env';
import { registerJob } from '../../lib/jobs';
import { registerTaskDetailExtension } from '../tasks/service';
import { pollTick, reconcileTick, resetReconcileFlag } from './service';
import { ninjaSettings, ninjaTicketUrl } from './store';

/** NinjaOne: poll + reconcile jobs and the `ninjaTicket` task detail key. */
export async function setup() {
  if (env.JOBS_ENABLED) await resetReconcileFlag();
  // the poll interval and reconcile time come from the (hot-reloadable) config, so the jobs tick often and decide
  registerJob('ninja.poll', 15_000, pollTick);
  registerJob('ninja.reconcile', 60_000, reconcileTick);

  registerTaskDetailExtension('ninjaTicket', async (tx, task) => {
    const [t] = await tx.select().from(ninjaTickets).where(eq(ninjaTickets.taskId, task.id)).limit(1);
    if (!t) return null;
    const s = await ninjaSettings();
    const snap = t.snapshot as Record<string, unknown>;
    return { ticketId: t.ticketId, url: ninjaTicketUrl(s.region, t.ticketId), status: snap.__status ?? null, lastPolledAt: t.lastPolledAt };
  });
}
