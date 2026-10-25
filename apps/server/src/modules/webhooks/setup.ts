import { on } from '../../lib/events';
import { registerJob } from '../../lib/jobs';
import { log } from '../../lib/log';
import { deliverDue, onDomainEvent, pruneDeliveries } from './service';

/** Outbound webhooks: fan out every domain event into deliveries; a job sends them with retries. */
export async function setup() {
  on('*', async (e) => {
    try {
      await onDomainEvent(e);
    } catch (err) {
      log.error({ err, event: e.type }, 'webhook fan-out failed');
    }
  });
  registerJob('webhooks.deliver', 5_000, deliverDue);
  registerJob('webhooks.prune', 24 * 60 * 60_000, pruneDeliveries);
}
