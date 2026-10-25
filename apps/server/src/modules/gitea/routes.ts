import { eq } from 'drizzle-orm';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { db } from '../../db/client';
import { giteaLinks } from '../../db/schema';
import { env } from '../../env';
import { hmacSha256, safeEqual } from '../../lib/crypto';
import { HttpError, NotFound, Validation } from '../../lib/errors';
import { auth, parse, type Params } from '../../lib/http';
import { log } from '../../lib/log';
import { runTx } from '../../lib/tx';
import { recordRun } from '../integrations/health';
import { findTask } from '../tasks/service';
import { GiteaError, giteaApi, giteaSettings, splitRepo } from './client';
import { branchNameFor, handleGiteaEvent, upsertLink } from './service';

declare module 'fastify' {
  interface FastifyRequest {
    rawBody?: Buffer;
  }
}

const branchSchema = z.object({
  repo: z.string().min(3),
  name: z.string().trim().min(1).max(200).regex(/^[^\s~^:?*[\\]+$/, 'Not a valid branch name').optional(),
  from: z.string().trim().min(1).max(200).optional(),
});
const issueSchema = z.object({
  repo: z.string().min(3),
  title: z.string().trim().min(1).max(250).optional(),
  body: z.string().max(20000).optional(),
});

/** /api/integrations/gitea — inbound webhook (HMAC, no session) + create branch/issue from a task. */
export default async function giteaRoutes(app: FastifyInstance) {
  // Keep the raw bytes for HMAC verification. Scoped to this plugin (Fastify encapsulation).
  app.removeContentTypeParser('application/json');
  app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (req: FastifyRequest, body: Buffer, done) => {
    req.rawBody = body;
    if (!body.length) return done(null, {});
    try {
      done(null, JSON.parse(body.toString('utf8')));
    } catch {
      const err = new Error('Invalid JSON body') as Error & { statusCode: number };
      err.statusCode = 400;
      done(err, undefined);
    }
  });

  app.post('/webhook', { config: { rateLimit: { max: 300, timeWindow: '1 minute' } } }, async (req, reply) => {
    const s = await giteaSettings();
    if (!s.enabled || !s.webhookSecret) return reply.code(404).send({ error: 'Gitea integration is not enabled' });
    const sig = req.headers['x-gitea-signature'];
    const raw = req.rawBody;
    if (typeof sig !== 'string' || !sig || !raw) {
      log.warn({ ip: req.ip }, 'gitea webhook rejected: unsigned');
      return reply.code(401).send({ error: 'Missing signature' });
    }
    const expected = hmacSha256(s.webhookSecret, raw);
    if (!safeEqual(sig.trim().toLowerCase().replace(/^sha256=/, ''), expected)) {
      log.warn({ ip: req.ip }, 'gitea webhook rejected: bad signature');
      return reply.code(401).send({ error: 'Invalid signature' });
    }
    const event = String(req.headers['x-gitea-event'] ?? req.headers['x-gogs-event'] ?? '');
    if (!event) throw new Validation('Missing X-Gitea-Event header');
    const result = await recordRun('gitea', `webhook:${event}`, () => handleGiteaEvent(event, (req.body ?? {}) as Record<string, unknown>));
    return { ok: true, ...result };
  });

  /** Repos offered in the task's Development panel. */
  app.get('/repos', async (req) => {
    auth(req);
    const s = await giteaSettings();
    return { enabled: s.enabled && !!s.baseUrl && !!s.apiToken, repos: s.repos, baseUrl: s.baseUrl || null };
  });

  app.post<{ Params: Params<'ref'> }>('/tasks/:ref/branch', async (req) => {
    const { access } = auth(req);
    const input = parse(branchSchema, req.body);
    const task = await findTask(db, req.params.ref);
    if (!task) throw new NotFound();
    await access.require('edit', 'task', task.id);
    const s = await requireConfigured(input.repo);
    const name = input.name ?? branchNameFor(s.branchTemplate, task);
    const { owner, name: repoName } = splitRepo(input.repo);
    const result = await recordRun('gitea', 'create-branch', async () => {
      const from = input.from ?? (await giteaApi<{ default_branch: string }>(s, 'GET', `/repos/${owner}/${repoName}`)).default_branch;
      await giteaApi(s, 'POST', `/repos/${owner}/${repoName}/branches`, { new_branch_name: name, old_branch_name: from });
      return { repo: input.repo, branch: name, from };
    }, { quietHealth: true }).catch(rethrowGitea);
    const url = `${s.baseUrl}/${input.repo}/src/branch/${name.split('/').map(encodeURIComponent).join('/')}`;
    await runTx((tx) => upsertLink(tx, task.id, { repo: input.repo, kind: 'branch', ref: name, title: name, url, state: 'open', author: req.user?.displayName ?? null }));
    return { ok: true, branch: name, from: result.from, url };
  });

  app.post<{ Params: Params<'ref'> }>('/tasks/:ref/issue', async (req) => {
    const { access } = auth(req);
    const input = parse(issueSchema, req.body);
    const task = await findTask(db, req.params.ref);
    if (!task) throw new NotFound();
    await access.require('edit', 'task', task.id);
    const s = await requireConfigured(input.repo);
    const { owner, name: repoName } = splitRepo(input.repo);
    const link = `${env.PUBLIC_URL.replace(/\/$/, '')}/t/${task.key}`;
    const issue = await recordRun('gitea', 'create-issue', async () => {
      const r = await giteaApi<{ number: number; html_url: string; title: string; state: string }>(s, 'POST', `/repos/${owner}/${repoName}/issues`, {
        title: input.title ?? `${task.key}: ${task.name}`.slice(0, 250),
        body: `${input.body ? `${input.body}\n\n` : ''}Task: [${task.key}](${link})`,
      });
      return { number: r.number, url: r.html_url, title: r.title, state: r.state };
    }, { quietHealth: true }).catch(rethrowGitea);
    await runTx((tx) => upsertLink(tx, task.id, {
      repo: input.repo, kind: 'issue', ref: String(issue.number), title: issue.title, url: issue.url, state: issue.state ?? 'open', author: req.user?.displayName ?? null,
    }));
    return { ok: true, ...issue };
  });

  /** Remove a link from a task (edit permission on the task). */
  app.delete<{ Params: Params<'id'> }>('/links/:id', async (req) => {
    const { access } = auth(req);
    const [l] = await db.select().from(giteaLinks).where(eq(giteaLinks.id, req.params.id));
    if (!l) throw new NotFound();
    await access.require('edit', 'task', l.taskId);
    await db.delete(giteaLinks).where(eq(giteaLinks.id, l.id));
    return { ok: true };
  });
}

async function requireConfigured(repo: string) {
  const s = await giteaSettings();
  if (!s.enabled || !s.baseUrl || !s.apiToken) throw new Validation('The Gitea integration is not configured');
  if (!s.repos.includes(repo)) throw new Validation('That repository is not in the configured list');
  return s;
}

function rethrowGitea(err: unknown): never {
  if (err instanceof GiteaError) {
    throw new HttpError(err.status === 409 || err.status === 422 ? 409 : 502, err.message);
  }
  throw err;
}
