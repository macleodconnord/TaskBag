import { verify as argonVerify } from '@node-rs/argon2';
import { and, asc, eq, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import * as OTPAuth from 'otpauth';
import { z } from 'zod';
import { db } from '../../db/client';
import { sessions, users } from '../../db/schema';
import { env } from '../../env';
import { decrypt, encrypt } from '../../lib/crypto';
import { Forbidden, NotFound, Unauthorized } from '../../lib/errors';
import { auth, parse } from '../../lib/http';
import { log } from '../../lib/log';
import { buildLoginUrl, completeLogin, entraSettings } from './entra';
import { clearCookies, createSession } from './session';

const OIDC_COOKIE = 'oidc_tx';
const authLimit = { config: { rateLimit: { max: 10, timeWindow: '1 minute', keyGenerator: (r: { ip: string }) => r.ip } } };

export default async function authRoutes(app: FastifyInstance) {
  app.get('/config', async () => ({
    sso: !!(await entraSettings()),
    devLogin: env.DEV_LOGIN,
    breakglass: env.BREAKGLASS_ENABLED,
  }));

  app.get('/me', async (req) => {
    const { user } = auth(req);
    return { user, viaBreakglass: req.viaBreakglass };
  });

  // ── Entra ID (OIDC auth code + PKCE) ──
  app.get('/login', authLimit, async (req, reply) => {
    const tx = await buildLoginUrl();
    if (!tx) return reply.redirect('/login?error=sso_not_configured');
    const { returnTo } = req.query as { returnTo?: string };
    const payload = encrypt(JSON.stringify({ v: tx.verifier, s: tx.state, n: tx.nonce, r: safeReturn(returnTo), t: Date.now() }));
    reply.setCookie(OIDC_COOKIE, payload, { path: '/api/auth', httpOnly: true, sameSite: 'lax', secure: env.PUBLIC_URL.startsWith('https://'), maxAge: 600 });
    return reply.redirect(tx.url);
  });

  app.get('/callback', authLimit, async (req, reply) => {
    const raw = req.cookies[OIDC_COOKIE];
    reply.clearCookie(OIDC_COOKIE, { path: '/api/auth' });
    if (!raw) return reply.redirect('/login?error=expired');
    let tx: { v: string; s: string; n: string; r: string; t: number };
    try {
      tx = JSON.parse(decrypt(raw));
    } catch {
      return reply.redirect('/login?error=expired');
    }
    if (Date.now() - tx.t > 10 * 60_000) return reply.redirect('/login?error=expired');
    try {
      const callbackUrl = new URL(req.url, env.PUBLIC_URL);
      const user = await completeLogin(callbackUrl, { verifier: tx.v, state: tx.s, nonce: tx.n });
      await createSession(req, reply, user.id);
      return reply.redirect(tx.r || '/');
    } catch (err) {
      log.warn({ err }, 'SSO login failed');
      const msg = err instanceof Forbidden ? err.message : 'Sign-in failed. Try again or contact an admin.';
      return reply.redirect(`/login?error=${encodeURIComponent(msg)}`);
    }
  });

  // ── Dev login (DEV_LOGIN=true only) ──
  app.get('/dev-users', async () => {
    if (!env.DEV_LOGIN) throw new NotFound();
    return db.select({ id: users.id, displayName: users.displayName, email: users.email, role: users.role })
      .from(users).where(and(eq(users.isActive, true), eq(users.isSystem, false))).orderBy(asc(users.displayName));
  });
  app.post('/dev-login', async (req, reply) => {
    if (!env.DEV_LOGIN) throw new NotFound();
    const { userId } = parse(z.object({ userId: z.string().uuid() }), req.body);
    const [u] = await db.select().from(users).where(eq(users.id, userId));
    if (!u || !u.isActive || u.isSystem) throw new NotFound();
    await createSession(req, reply, u.id);
    return { ok: true };
  });

  // ── Break-glass local admin (BREAKGLASS_ENABLED=true only) ──
  app.post('/local', authLimit, async (req, reply) => {
    if (!env.BREAKGLASS_ENABLED) throw new NotFound();
    const body = parse(z.object({ email: z.string().min(1), password: z.string().min(1), totp: z.string().optional() }), req.body);
    const [u] = await db.select().from(users)
      .where(and(sql`lower(${users.email}) = ${body.email.toLowerCase()}`, eq(users.isBreakglass, true)));
    const ok = !!u?.passwordHash && u.isActive && (await argonVerify(u.passwordHash, body.password).catch(() => false));
    if (!ok) {
      log.warn({ email: body.email, ip: req.ip }, 'break-glass login failed');
      throw new Unauthorized('Invalid credentials');
    }
    if (u.totpSecretEnc) {
      if (!body.totp) return reply.code(401).send({ error: 'TOTP code required', totpRequired: true });
      const totp = new OTPAuth.TOTP({ secret: OTPAuth.Secret.fromBase32(decrypt(u.totpSecretEnc)) });
      if (totp.validate({ token: body.totp.replace(/\s/g, ''), window: 1 }) === null) throw new Unauthorized('Invalid TOTP code');
    }
    log.warn({ userId: u.id, ip: req.ip }, 'break-glass login used');
    await createSession(req, reply, u.id, true);
    return { ok: true };
  });

  app.post('/logout', async (req, reply) => {
    if (req.sessionId) await db.delete(sessions).where(eq(sessions.id, req.sessionId));
    clearCookies(reply);
    return { ok: true };
  });
}

function safeReturn(r: string | undefined) {
  return r && r.startsWith('/') && !r.startsWith('//') ? r : '/';
}
