import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import multipart from '@fastify/multipart';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyInstance } from 'fastify';
import { sql } from 'drizzle-orm';
import { db } from './db/client';
import { env, isDev } from './env';
import { HttpError } from './lib/errors';
import { loggerOptions } from './lib/log';
import { loadSession, SESSION_COOKIE, CSRF_HEADER } from './modules/auth/session';
import { safeEqual } from './lib/crypto';
import { modules } from './modules';

/** Routes that accept unauthenticated requests or authenticate themselves (HMAC etc.). */
const PUBLIC_PREFIXES = ['/api/health', '/api/auth/', '/api/integrations/gitea/webhook'];
const CSRF_EXEMPT = ['/api/auth/', '/api/integrations/gitea/webhook'];

export async function buildApp(): Promise<FastifyInstance> {
  const trustProxy = env.TRUSTED_PROXY_CIDRS ? env.TRUSTED_PROXY_CIDRS.split(',').map((s) => s.trim()).filter(Boolean) : false;
  const app = Fastify({
    logger: env.NODE_ENV === 'test' ? false : loggerOptions,
    trustProxy,
    bodyLimit: 10 * 1024 * 1024,
    genReqId: () => Math.random().toString(36).slice(2, 10),
  });

  await app.register(cookie);
  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        imgSrc: ["'self'", 'data:', 'blob:', 'https:'],
        styleSrc: ["'self'", "'unsafe-inline'"],
        scriptSrc: ["'self'"],
        connectSrc: ["'self'"],
        frameSrc: ["'self'"],
        objectSrc: ["'self'"],
        upgradeInsecureRequests: null,
      },
    },
    hsts: false, // set by the networking team's proxy
    crossOriginEmbedderPolicy: false,
  });
  await app.register(rateLimit, {
    max: 600,
    timeWindow: '1 minute',
    keyGenerator: (req) => req.user?.id ?? req.ip,
    allowList: (req) => !req.url.startsWith('/api/'),
  });
  await app.register(multipart, { limits: { fileSize: env.MAX_UPLOAD_MB * 1024 * 1024, files: 20 } });

  app.decorateRequest('user', null);
  app.decorateRequest('sessionId', null);
  app.decorateRequest('viaBreakglass', false);
  app.decorateRequest('_access', null);
  app.decorateRequest('csrfToken', null);

  app.addHook('onRequest', async (req, reply) => {
    if (!req.url.startsWith('/api/')) return;
    const token = req.cookies[SESSION_COOKIE];
    if (token) await loadSession(req, reply, token);
    const path = req.url.split('?')[0];
    if (!req.user && !PUBLIC_PREFIXES.some((p) => path.startsWith(p))) {
      return reply.code(401).send({ error: 'Sign in required' });
    }
    if (req.user && !['GET', 'HEAD', 'OPTIONS'].includes(req.method) && !CSRF_EXEMPT.some((p) => path.startsWith(p))) {
      const header = req.headers[CSRF_HEADER];
      const expected = req.csrfToken;
      if (typeof header !== 'string' || !expected || !safeEqual(header, expected)) {
        return reply.code(403).send({ error: 'Invalid CSRF token. Reload the page and try again.' });
      }
    }
  });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof HttpError) {
      return reply.code(err.status).send({ error: err.message, details: err.details });
    }
    const e = err as { statusCode?: number; message?: string; code?: string };
    if (e.statusCode && e.statusCode < 500) return reply.code(e.statusCode).send({ error: e.message });
    // Postgres unique violation → 409
    if (e.code === '23505') return reply.code(409).send({ error: 'That already exists' });
    req.log.error({ err }, 'unhandled error');
    return reply.code(500).send({ error: 'Something went wrong' });
  });

  app.get('/api/health', async () => ({ ok: true }));
  app.get('/api/health/ready', async (_req, reply) => {
    try {
      await db.execute(sql`select 1`);
      return { ok: true };
    } catch {
      return reply.code(503).send({ ok: false });
    }
  });

  for (const [prefix, plugin] of modules) await app.register(plugin, { prefix: `/api${prefix}` });

  // Production: serve the built SPA from the same port.
  const webRoot = [resolve(process.cwd(), 'web'), resolve(process.cwd(), '../web/dist')].find((p) => existsSync(resolve(p, 'index.html')));
  if (webRoot && !isDev) {
    await app.register(fastifyStatic, {
      root: webRoot,
      wildcard: false,
      setHeaders: (res, path) => {
        if (/[\\/]assets[\\/]/.test(path)) res.setHeader('cache-control', 'public, max-age=31536000, immutable');
      },
    });
  }

  app.setNotFoundHandler((req, reply) => {
    if (req.url.startsWith('/api/')) return reply.code(404).send({ error: 'Not found' });
    if (webRoot && !isDev) return reply.type('text/html').header('cache-control', 'no-cache').sendFile('index.html');
    return reply.code(404).send('Not found');
  });

  return app;
}
