import type { FastifyReply, FastifyRequest } from 'fastify';
import type { z } from 'zod';
import type { AccessContext } from './access';
import { Unauthorized, Validation } from './errors';

/** Parse request input with zod; 400 with field issues on failure. */
export function parse<S extends z.ZodType>(schema: S, data: unknown): z.infer<S> {
  const r = schema.safeParse(data);
  if (!r.success) {
    const issues = r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message }));
    throw new Validation(issues[0] ? `${issues[0].path || 'input'}: ${issues[0].message}` : 'Invalid input', issues);
  }
  return r.data;
}

export interface SessionUser {
  id: string;
  email: string;
  displayName: string;
  role: 'owner' | 'admin' | 'member' | 'guest';
  isActive: boolean;
  isBreakglass: boolean;
  timezone: string | null;
  theme: string;
  avatarUrl: string | null;
}

declare module 'fastify' {
  interface FastifyRequest {
    user: SessionUser | null;
    sessionId: string | null;
    viaBreakglass: boolean;
    _access: AccessContext | null;
    csrfToken: string | null;
  }
}

/** The signed-in user and their access context; throws 401 when anonymous. */
export function auth(req: FastifyRequest): { user: SessionUser; access: AccessContext } {
  if (!req.user || !req._access) throw new Unauthorized();
  return { user: req.user, access: req._access };
}

export type Req = FastifyRequest;
export type Rep = FastifyReply;
export type Params<K extends string> = Record<K, string>;
