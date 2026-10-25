import * as oidc from 'openid-client';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { db } from '../../db/client';
import { groupMembers, groups, users } from '../../db/schema';
import { env } from '../../env';
import { bumpAcl } from '../../lib/access';
import { Forbidden } from '../../lib/errors';
import { getIntegrationConfig, onIntegrationConfigChange } from '../../lib/integration-config';

export interface EntraSettings {
  tenantId: string;
  clientId: string;
  defaultRole: 'member' | 'guest';
  /** If non-empty, the user must be in at least one of these Entra group object ids */
  requiredGroupIds: string[];
  syncGroups: boolean;
}

let cached: { key: string; config: oidc.Configuration } | null = null;
onIntegrationConfigChange((k) => {
  if (k === 'entra') cached = null;
});

export const redirectUri = () => `${env.PUBLIC_URL.replace(/\/$/, '')}/api/auth/callback`;

export async function entraSettings(): Promise<(EntraSettings & { clientSecret: string }) | null> {
  const cfg = await getIntegrationConfig('entra');
  const c = cfg.config as Partial<EntraSettings>;
  if (!cfg.enabled || !c.tenantId || !c.clientId || !cfg.secrets.clientSecret) return null;
  return {
    tenantId: c.tenantId,
    clientId: c.clientId,
    defaultRole: c.defaultRole === 'guest' ? 'guest' : 'member',
    requiredGroupIds: Array.isArray(c.requiredGroupIds) ? c.requiredGroupIds.filter(Boolean) : [],
    syncGroups: c.syncGroups !== false,
    clientSecret: cfg.secrets.clientSecret,
  };
}

export async function oidcConfig(): Promise<oidc.Configuration | null> {
  const s = await entraSettings();
  if (!s) return null;
  const key = `${s.tenantId}:${s.clientId}:${s.clientSecret.length}`;
  if (cached?.key === key) return cached.config;
  const config = await oidc.discovery(new URL(`https://login.microsoftonline.com/${s.tenantId}/v2.0`), s.clientId, s.clientSecret);
  cached = { key, config };
  return config;
}

export async function buildLoginUrl() {
  const config = await oidcConfig();
  if (!config) return null;
  const verifier = oidc.randomPKCECodeVerifier();
  const state = oidc.randomState();
  const nonce = oidc.randomNonce();
  const url = oidc.buildAuthorizationUrl(config, {
    redirect_uri: redirectUri(),
    scope: 'openid profile email',
    code_challenge: await oidc.calculatePKCECodeChallenge(verifier),
    code_challenge_method: 'S256',
    state,
    nonce,
  });
  return { url: url.href, verifier, state, nonce };
}

interface Claims {
  oid?: string;
  sub: string;
  email?: string;
  preferred_username?: string;
  name?: string;
  groups?: string[];
}

/** Exchange the code, then find-or-provision the user and sync Entra group memberships. */
export async function completeLogin(callbackUrl: URL, check: { verifier: string; state: string; nonce: string }) {
  const config = await oidcConfig();
  const s = await entraSettings();
  if (!config || !s) throw new Forbidden('Single sign-on is not configured');
  const tokens = await oidc.authorizationCodeGrant(config, callbackUrl, {
    pkceCodeVerifier: check.verifier,
    expectedState: check.state,
    expectedNonce: check.nonce,
  });
  const claims = tokens.claims() as unknown as Claims;
  const oid = claims.oid ?? claims.sub;
  const email = (claims.email ?? claims.preferred_username ?? '').toLowerCase();
  const groupClaims = Array.isArray(claims.groups) ? claims.groups : [];
  if (s.requiredGroupIds.length && !s.requiredGroupIds.some((g) => groupClaims.includes(g))) {
    throw new Forbidden('Your account is not in a group allowed to use this app');
  }

  let [user] = await db.select().from(users).where(eq(users.entraOid, oid));
  if (!user && email) {
    [user] = await db.select().from(users).where(sql`lower(${users.email}) = ${email}`);
    if (user) {
      await db.update(users).set({ entraOid: oid, isPlaceholder: false }).where(eq(users.id, user.id));
    }
  }
  if (!user) {
    [user] = await db.insert(users).values({
      email: email || `${oid}@entra.invalid`,
      displayName: claims.name ?? email ?? 'New user',
      entraOid: oid,
      role: s.defaultRole,
    }).returning();
  } else if (claims.name && user.isPlaceholder) {
    await db.update(users).set({ displayName: claims.name }).where(eq(users.id, user.id));
  }
  if (!user.isActive) throw new Forbidden('Your account has been deactivated');
  if (s.syncGroups) await syncEntraGroups(user.id, groupClaims);
  return user;
}

async function syncEntraGroups(userId: string, entraGroupIds: string[]) {
  const linked = entraGroupIds.length
    ? await db.select({ id: groups.id }).from(groups).where(inArray(groups.entraGroupId, entraGroupIds))
    : [];
  const want = new Set(linked.map((g) => g.id));
  const have = await db.select().from(groupMembers).where(and(eq(groupMembers.userId, userId), eq(groupMembers.source, 'entra')));
  const remove = have.filter((m) => !want.has(m.groupId)).map((m) => m.groupId);
  const add = [...want].filter((g) => !have.some((m) => m.groupId === g));
  if (remove.length) await db.delete(groupMembers).where(and(eq(groupMembers.userId, userId), inArray(groupMembers.groupId, remove)));
  if (add.length) await db.insert(groupMembers).values(add.map((groupId) => ({ groupId, userId, source: 'entra' as const }))).onConflictDoNothing();
  if (remove.length || add.length) bumpAcl();
}

/** "Test connection": OIDC discovery reachable and the client secret accepted by the token endpoint. */
export async function testEntra(): Promise<{ ok: boolean; detail: string }> {
  const s = await entraSettings();
  if (!s) return { ok: false, detail: 'Tenant ID, client ID and client secret are required' };
  try {
    cached = null;
    const config = await oidcConfig();
    await oidc.clientCredentialsGrant(config!, { scope: 'https://graph.microsoft.com/.default' });
    return { ok: true, detail: `Discovery OK (${config!.serverMetadata().issuer}); client secret accepted` };
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message : String(err) };
  }
}
