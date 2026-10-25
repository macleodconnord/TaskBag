import { env } from '../../env';
import { getIntegrationConfig } from '../../lib/integration-config';

export const giteaWebhookUrl = () => `${env.PUBLIC_URL.replace(/\/$/, '')}/api/integrations/gitea/webhook`;

export interface GiteaSettings {
  enabled: boolean;
  baseUrl: string;
  apiToken: string;
  webhookSecret: string;
  repos: string[];
  branchTemplate: string;
}

export async function giteaSettings(): Promise<GiteaSettings> {
  const cfg = await getIntegrationConfig('gitea');
  const c = cfg.config as Record<string, unknown>;
  return {
    enabled: cfg.enabled,
    baseUrl: typeof c.baseUrl === 'string' ? c.baseUrl.replace(/\/+$/, '') : '',
    apiToken: cfg.secrets.apiToken ?? '',
    webhookSecret: cfg.secrets.webhookSecret ?? '',
    repos: Array.isArray(c.repos) ? c.repos.filter((r): r is string => typeof r === 'string' && r.includes('/')) : [],
    branchTemplate: typeof c.branchTemplate === 'string' && c.branchTemplate ? c.branchTemplate : 'feat/{key}-{slug}',
  };
}

export class GiteaError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

/** Minimal Gitea REST client (token auth). */
export async function giteaApi<T>(s: Pick<GiteaSettings, 'baseUrl' | 'apiToken'>, method: string, path: string, body?: unknown): Promise<T> {
  if (!s.baseUrl) throw new GiteaError(400, 'Gitea base URL is not configured');
  if (!s.apiToken) throw new GiteaError(400, 'Gitea API token is not configured');
  const res = await fetch(`${s.baseUrl}/api/v1${path}`, {
    method,
    headers: {
      authorization: `token ${s.apiToken}`,
      accept: 'application/json',
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15_000),
  });
  const text = await res.text();
  if (!res.ok) {
    let msg = text.slice(0, 300);
    try {
      msg = (JSON.parse(text) as { message?: string }).message ?? msg;
    } catch { /* not json */ }
    throw new GiteaError(res.status, `Gitea ${method} ${path} failed (${res.status}): ${msg}`);
  }
  return (text ? JSON.parse(text) : null) as T;
}

export const splitRepo = (full: string) => {
  const [owner, ...rest] = full.split('/');
  return { owner: encodeURIComponent(owner), name: encodeURIComponent(rest.join('/')) };
};
