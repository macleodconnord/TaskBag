import { registerJob } from '../../lib/jobs';
import { drainOutbox, runDigests } from './email';
import { registerFanout, scanDueDates } from './service';

export { notify, notifyAdmins } from './service';
export { registerNotificationChannel, type NotificationChannel } from './channels';

/** Startup wiring for notifications: event fan-out, due-date scan, email outbox and digests. */
export async function setup() {
  registerFanout();
  registerJob('notifications-due-scan', 60_000, () => scanDueDates());
  registerJob('email-outbox', 15_000, () => drainOutbox());
  registerJob('email-digests', 5 * 60_000, () => runDigests());
}
