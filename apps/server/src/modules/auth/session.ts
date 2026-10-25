import { eq } from 'drizzle-orm';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { db } from '../../db/client';
import { sessions, users } from '../../db/schema';
import { env, isDev } from '../../env';
import { AccessContext } from '../../lib/access';
import { randomToken, sha256 } from '../../lib/crypto';

export const SESSION_COOKIE = 'sid';
export const CSRF_COOKIE = 'csrf';
export const CSRF_HEADER = 'x-csrf-token';

const IDLE_MS = 12 * 60 * 60 * 1000; // 12h sliding
const MAX_MS = 8 * 24 * 60 * 60 * 1000; // 8 days absolute
const secure = !isDev && env.PUBLIC_URL.startsWith('https://');

export async function createSession(req: FastifyRequest, reply: FastifyReply, userId: string, viaBreakglass = false) {
  const token = randomToken();
  const csrf = randomToken(18);
  const now = Date.now();
  await db.insert(sessions).values({
    id: sha256(token),
    userId,
    csrfToken: csrf,
    viaBreakglass,
    expiresAt: new Date(now + IDLE_MS),
    ip: req.ip,
    userAgent: req.headers['user-agent']?.slice(0, 300) ?? null,
  });
  await db.update(users).set({ lastLoginAt: new Date() }).where(eq(users.id, userId));
  setCookies(reply, token, csrf);
}

function setCookies(reply: FastifyReply, token: string, csrf: string) {
  const base = { path: '/', sameSite: 'lax' as const, secure, maxAge: MAX_MS / 1000 };
  reply.setCookie(SESSION_COOKIE, token, { ...base, httpOnly: true });
  reply.setCookie(CSRF_COOKIE, csrf, { ...base, httpOnly: false });
}

export function clearCookies(reply: FastifyReply) {
  reply.clearCookie(SESSION_COOKIE, { path: '/' });
  reply.clearCookie(CSRF_COOKIE, { path: '/' });
}

export async function loadSession(req: FastifyRequest, reply: FastifyReply, token: string) {
  const id = sha256(token);
  const [row] = await db
    .select({ s: sessions, u: users })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(eq(sessions.id, id));
  const now = Date.now();
  if (!row || row.s.expiresAt.getTime() < now || row.s.createdAt.getTime() + MAX_MS < now || !row.u.isActive) {
    if (row) await db.delete(sessions).where(eq(sessions.id, id));
    clearCookies(reply);
    return;
  }
  // sliding expiry; write at most once a minute
  if (now - row.s.lastSeenAt.getTime() > 60_000) {
    const expiresAt = new Date(Math.min(now + IDLE_MS, row.s.createdAt.getTime() + MAX_MS));
    await db.update(sessions).set({ lastSeenAt: new Date(now), expiresAt }).where(eq(sessions.id, id));
  }
  const u = row.u;
  req.user = {
    id: u.id, email: u.email, displayName: u.displayName, role: u.role, isActive: u.isActive,
    isBreakglass: u.isBreakglass, timezone: u.timezone, theme: u.theme, avatarUrl: u.avatarUrl,
  };
  req.sessionId = id;
  req.csrfToken = row.s.csrfToken;
  req.viaBreakglass = row.s.viaBreakglass;
  req._access = new AccessContext({ id: u.id, role: u.role, isActive: u.isActive });
}

export async function revokeUserSessions(userId: string) {
  await db.delete(sessions).where(eq(sessions.userId, userId));
}
