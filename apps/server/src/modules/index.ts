import type { FastifyPluginAsync } from 'fastify';
import attachments from './attachments/routes';
import auth from './auth/routes';
import comments from './comments/routes';
import docs from './docs/routes';
import fields from './fields/routes';
import gitea from './gitea/routes';
import hierarchy from './hierarchy/routes';
import importer from './import/routes';
import integrations from './integrations/routes';
import listLinks from './list-links/routes';
import ninjaone from './ninjaone/routes';
import notifications from './notifications/routes';
import search from './search/routes';
import tasks from './tasks/routes';
import templates from './templates/routes';
import users from './users/routes';
import views from './views/routes';
import webhooks from './webhooks/routes';

/**
 * Every API module, mounted at /api<prefix>. Feature startup wiring (event handlers,
 * task/list extensions, background jobs) lives in each module's setup.ts, called from ../setup.ts.
 */
export const modules: Array<[string, FastifyPluginAsync]> = [
  ['/auth', auth],
  ['/users', users],
  ['/hierarchy', hierarchy],
  ['/tasks', tasks],
  ['/comments', comments],
  ['/attachments', attachments],
  ['/search', search],
  ['/views', views],
  ['/fields', fields],
  ['/templates', templates],
  ['/list-links', listLinks],
  ['/notifications', notifications],
  ['/docs', docs],
  ['/integrations', integrations],
  ['/integrations/gitea', gitea],
  ['/integrations/ninjaone', ninjaone],
  ['/webhooks', webhooks],
  ['/import', importer],
];
