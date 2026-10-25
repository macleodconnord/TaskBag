import { eq } from 'drizzle-orm';
import { db } from '../../db/client';
import { notifications } from '../../db/schema';
import type { AccessContext } from '../../lib/access';
import { DEFAULT_TZ } from '../../lib/dates';
import { enqueueEmail, instantEmail, smtpSettings } from './email';
import type { ChannelPref } from './prefs';
import { renderNotifications, type NotificationRow } from './render';

/**
 * A delivery channel for notifications (N-05).
 *
 * The core (service.ts) decides *whether* a recipient gets a notification: it computes the
 * recipients, drops anyone who can't view the task/doc, dedupes, stores the `notifications` row
 * (which is the in-app inbox) and resolves the recipient's preference for each channel. A channel
 * only decides *how* to deliver it.
 *
 * To add a channel (e.g. Teams): implement this interface, call `registerNotificationChannel()`
 * from a module's setup(), and add its key to PREF_CHANNELS in prefs.ts so users can toggle it.
 * Render content with `renderNotifications()` — never from the event payload — so it reflects the
 * recipient's current access.
 */
export interface NotificationChannel {
  /** matches notification_preferences.channel */
  key: string;
  /** Deliver one notification. Called only when the recipient's preference for this channel is enabled. */
  deliver(ctx: DeliveryContext): Promise<void>;
}

export interface DeliveryContext {
  notification: NotificationRow;
  recipient: { id: string; email: string; displayName: string; timezone: string | null };
  /** the recipient's access context (already checked: they can view the task/doc) */
  access: AccessContext;
  pref: ChannelPref;
}

/** In-app: the notifications row *is* the inbox entry, so there's nothing more to do. */
export const inAppChannel: NotificationChannel = {
  key: 'in_app',
  async deliver() {},
};

/** Email: instant emails are rendered now and queued in email_outbox; digests are sent by the digest job. */
export const emailChannel: NotificationChannel = {
  key: 'email',
  async deliver({ notification, recipient, access, pref }) {
    if (pref.digest !== 'instant') return; // picked up by runDigests()
    if (!recipient.email || !(await smtpSettings())) return;
    const [item] = await renderNotifications([notification], access, recipient.timezone ?? DEFAULT_TZ);
    if (!item || item.redacted) return;
    await enqueueEmail({ userId: recipient.id, to: recipient.email, ...instantEmail(item) });
    await db.update(notifications).set({ emailedAt: new Date() }).where(eq(notifications.id, notification.id));
  },
};

const channels = new Map<string, NotificationChannel>([[inAppChannel.key, inAppChannel], [emailChannel.key, emailChannel]]);

export const registerNotificationChannel = (c: NotificationChannel) => channels.set(c.key, c);
export const notificationChannels = () => [...channels.values()];
