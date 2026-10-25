import type { IntegrationKey } from '@app/shared';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import nodemailer from 'nodemailer';
import { getIntegrationConfig } from '../../lib/integration-config';
import type { SessionUser } from '../../lib/http';
import { testEntra } from '../auth/entra';
import { giteaApi, giteaSettings, giteaWebhookUrl } from '../gitea/client';
import { testNinja } from '../ninjaone/service';

export interface TestResult {
  ok: boolean;
  detail: string;
  data?: Record<string, unknown>;
}

const msg = (err: unknown) => (err instanceof Error ? err.message : String(err));

async function testSmtp(admin: SessionUser): Promise<TestResult> {
  const cfg = await getIntegrationConfig('smtp');
  const c = cfg.config as Record<string, unknown>;
  if (!c.host || !c.from) return { ok: false, detail: 'Host and from address are required' };
  const secure = String(c.secure ?? 'starttls');
  const host = String(c.host);
  // nodemailer's own DNS client can't see hosts-file names ("localhost") on some systems; use the OS resolver
  const address = isIP(host) ? host : (await lookup(host, { family: 0 }).catch(() => ({ address: host }))).address;
  const transport = nodemailer.createTransport({
    host: address,
    tls: isIP(host) ? undefined : { servername: host },
    port: Number(c.port ?? 587),
    secure: secure === 'tls',
    requireTLS: secure === 'starttls',
    ignoreTLS: secure === 'none',
    auth: c.username ? { user: String(c.username), pass: cfg.secrets.password ?? '' } : undefined,
    connectionTimeout: 15_000,
    greetingTimeout: 30_000,
  });
  try {
    await transport.verify();
    const from = c.fromName ? `"${String(c.fromName).replace(/"/g, '')}" <${c.from}>` : String(c.from);
    const info = await transport.sendMail({
      from,
      to: admin.email,
      subject: 'Test email from Project',
      text: `This is a test email sent from Admin → Integrations by ${admin.displayName}. SMTP is working.`,
      html: `<p>This is a test email sent from <b>Admin → Integrations</b> by ${escapeHtml(admin.displayName)}.</p><p>SMTP is working.</p>`,
    });
    return { ok: true, detail: `Connected${c.username ? " and authenticated" : ""}. Test email sent to ${admin.email} (${info.messageId}).` };
  } catch (err) {
    return { ok: false, detail: msg(err) };
  } finally {
    transport.close();
  }
}

async function testGitea(): Promise<TestResult> {
  const s = await giteaSettings();
  const webhookUrl = giteaWebhookUrl();
  if (!s.baseUrl || !s.apiToken) return { ok: false, detail: `Base URL and API token are required.\nWebhook URL: ${webhookUrl}`, data: { webhookUrl } };
  try {
    const user = await giteaApi<{ login: string; full_name?: string }>(s, 'GET', '/user');
    const repos = await giteaApi<Array<{ full_name: string }>>(s, 'GET', '/user/repos?limit=50');
    const names = repos.map((r) => r.full_name);
    const missing = s.repos.filter((r) => !names.includes(r));
    const lines = [
      `Signed in as ${user.login}`,
      `${repos.length} repositor${repos.length === 1 ? 'y' : 'ies'} visible: ${names.slice(0, 20).join(', ')}${names.length > 20 ? ', …' : ''}`,
      ...(missing.length ? [`Configured but not visible to this token: ${missing.join(', ')}`] : []),
      `Webhook URL: ${webhookUrl}`,
      s.webhookSecret ? 'Webhook secret is set' : 'Webhook secret is NOT set — inbound webhooks will be rejected',
    ];
    return { ok: missing.length === 0, detail: lines.join('\n'), data: { webhookUrl, repos: names } };
  } catch (err) {
    return { ok: false, detail: `${msg(err)}\nWebhook URL: ${webhookUrl}`, data: { webhookUrl } };
  }
}

async function testClickUp(): Promise<TestResult> {
  const cfg = await getIntegrationConfig('clickup');
  const token = cfg.secrets.apiToken;
  if (!token) return { ok: false, detail: 'API token is required' };
  try {
    const res = await fetch('https://api.clickup.com/api/v2/team', { headers: { authorization: token }, signal: AbortSignal.timeout(15_000) });
    const limits = {
      limit: res.headers.get('x-ratelimit-limit'),
      remaining: res.headers.get('x-ratelimit-remaining'),
      reset: res.headers.get('x-ratelimit-reset'),
    };
    const rl = `Rate limit: ${limits.remaining ?? '?'} of ${limits.limit ?? '?'} remaining${limits.reset ? `, resets ${new Date(Number(limits.reset) * 1000).toLocaleTimeString()}` : ''}`;
    const text = await res.text();
    if (!res.ok) return { ok: false, detail: `ClickUp GET /team failed (${res.status}): ${text.slice(0, 200)}\n${rl}`, data: { limits } };
    const teams = (JSON.parse(text) as { teams?: Array<{ id: string; name: string }> }).teams ?? [];
    const teamId = (cfg.config as { teamId?: string }).teamId;
    const lines = [`${teams.length} workspace(s): ${teams.map((t) => `${t.name} (${t.id})`).join(', ')}`, rl];
    if (teamId && !teams.some((t) => String(t.id) === String(teamId))) lines.push(`Configured workspace ID ${teamId} is not visible to this token`);
    return { ok: !teamId || teams.some((t) => String(t.id) === String(teamId)), detail: lines.join('\n'), data: { limits, teams } };
  } catch (err) {
    return { ok: false, detail: msg(err) };
  }
}

export async function runIntegrationTest(key: IntegrationKey, admin: SessionUser): Promise<TestResult> {
  switch (key) {
    case 'entra': return testEntra();
    case 'smtp': return testSmtp(admin);
    case 'gitea': return testGitea();
    case 'ninjaone': return testNinja() as Promise<TestResult>;
    case 'clickup': return testClickUp();
  }
}

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
