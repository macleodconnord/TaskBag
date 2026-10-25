import { sql } from 'drizzle-orm';
import { db } from './db/client';
import { registerJob } from './lib/jobs';
import { purgeTrash } from './modules/tasks/service';
import { setup as docs } from './modules/docs/setup';
import { setup as fields } from './modules/fields/setup';
import { setup as gitea } from './modules/gitea/setup';
import { setup as importer } from './modules/import/setup';
import { setup as integrations } from './modules/integrations/setup';
import { setup as listLinks } from './modules/list-links/setup';
import { setup as ninjaone } from './modules/ninjaone/setup';
import { setup as notifications } from './modules/notifications/setup';
import { setup as templates } from './modules/templates/setup';
import { setup as views } from './modules/views/setup';
import { setup as webhooks } from './modules/webhooks/setup';

/** Wire event handlers, task/list extensions and background jobs, once, at startup. */
export async function setupModules() {
  registerJob('purge-trash', 6 * 60 * 60_000, () => purgeTrash(db));
  registerJob('session-prune', 60 * 60_000, () => db.execute(sql`delete from sessions where expires_at < now()`));
  for (const s of [views, fields, templates, listLinks, notifications, docs, integrations, gitea, ninjaone, webhooks, importer]) await s();
}
