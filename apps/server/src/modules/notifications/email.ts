import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { and, asc, eq, gt, inArray, isNull, lt, sql } from 'drizzle-orm';
import nodemailer, { type Transporter } from 'nodemailer';
import { db } from '../../db/client';
import { emailOutbox, notifications, users } from '../../db/schema';
import { accessForUser } from '../../lib/access';
import { DEFAULT_TZ, startOfDay } from '../../lib/dates';
import { env } from '../../env';
import { getIntegrationConfig, onIntegrationConfigChange } from '../../lib/integration-config';
import { log } from '../../lib/log';
import { userPrefs, workspaceTimezone } from './prefs';
import { renderNotifications, type RenderedNotification } from './render';

// ───────────── SMTP transport (settings from the credentials GUI) ─────────────

interface SmtpSettings {
  host: string;
  port: number;
  secure: 'none' | 'starttls' | 'tls';
  username?: string;
  password?: string;
  from: string;
  fromName?: string;
}

let transport: { key: string; t: Transporter } | null = null;
onIntegrationConfigChange((k) => { if (k === 'smtp') transport = null; });

/** Current SMTP settings, or null when email is disabled / not configured. */
export async function smtpSettings(): Promise<SmtpSettings | null> {
  const cfg = await getIntegrationConfig('smtp');
  const c = cfg.config;
  if (!cfg.enabled || typeof c.host !== 'string' || !c.host) return null;
  const secure = c.secure === 'tls' || c.secure === 'starttls' ? c.secure : 'none';
  return {
    host: c.host,
    port: Number(c.port) || (secure === 'tls' ? 465 : 25),
    secure,
    username: typeof c.username === 'string' && c.username ? c.username : undefined,
    password: cfg.secrets.password,
    from: typeof c.from === 'string' && c.from ? c.from : 'pm@localhost',
    fromName: typeof c.fromName === 'string' && c.fromName ? c.fromName : undefined,
  };
}

async function transporterFor(s: SmtpSettings): Promise<Transporter> {
  const key = JSON.stringify(s);
  if (transport?.key === key) return transport.t;
  // nodemailer resolves hosts with its own DNS client, which can't see hosts-file names such as
  // "localhost" on some systems; resolve with the OS resolver and keep the name for TLS.
  const address = isIP(s.host) ? s.host : (await lookup(s.host, { family: 0 }).catch(() => ({ address: s.host }))).address;
  const t = nodemailer.createTransport({
    host: address,
    port: s.port,
    secure: s.secure === 'tls',
    requireTLS: s.secure === 'starttls',
    ignoreTLS: s.secure === 'none',
    tls: isIP(s.host) ? undefined : { servername: s.host },
    auth: s.username ? { user: s.username, pass: s.password ?? '' } : undefined,
    connectionTimeout: 15_000,
    greetingTimeout: 15_000,
    socketTimeout: 30_000,
  });
  transport = { key, t };
  return t;
}

/** Send one message right now (used by the outbox drain and an SMTP "send test" button). */
export async function sendMail(msg: { to: string; subject: string; html: string; text: string }) {
  const s = await smtpSettings();
  if (!s) throw new Error('SMTP is not configured');
  try {
    await (await transporterFor(s)).sendMail({
      from: s.fromName ? { name: s.fromName, address: s.from } : s.from,
      to: msg.to, subject: msg.subject, html: msg.html, text: msg.text,
    });
  } catch (err) {
    transport = null; // re-resolve / reconnect next time
    throw err;
  }
}

// ───────────── outbox ─────────────

const MAX_ATTEMPTS = 8;

export async function enqueueEmail(m: { userId: string | null; to: string; subject: string; html: string; text: string }) {
  await db.insert(emailOutbox).values({ userId: m.userId, toAddress: m.to, subject: m.subject, html: m.html, text: m.text });
}

/** Job: send pending emails. Rows are leased (skip locked) so two API instances never double-send. */
export async function drainOutbox() {
  if (!(await smtpSettings())) return 0;
  const leased = await db.execute<{ id: string }>(sql`
    update email_outbox set next_attempt_at = now() + interval '5 minutes'
    where id in (
      select id from email_outbox where status = 'pending' and next_attempt_at <= now()
      order by created_at limit 25 for update skip locked
    ) returning id`);
  if (!leased.length) return 0;
  const rows = await db.select().from(emailOutbox).where(inArray(emailOutbox.id, leased.map((r) => r.id))).orderBy(asc(emailOutbox.createdAt));
  let sent = 0;
  for (const r of rows) {
    try {
      await sendMail({ to: r.toAddress, subject: r.subject, html: r.html, text: r.text });
      await db.update(emailOutbox).set({ status: 'sent', sentAt: new Date(), attempts: r.attempts + 1, lastError: null }).where(eq(emailOutbox.id, r.id));
      sent++;
    } catch (err) {
      const attempts = r.attempts + 1;
      const backoffMs = Math.min(60_000 * 2 ** (attempts - 1), 60 * 60_000);
      await db.update(emailOutbox).set({
        attempts,
        status: attempts >= MAX_ATTEMPTS ? 'failed' : 'pending',
        nextAttemptAt: new Date(Date.now() + backoffMs),
        lastError: (err instanceof Error ? err.message : String(err)).slice(0, 500),
      }).where(eq(emailOutbox.id, r.id));
      log.warn({ err, to: r.toAddress, attempts }, 'email send failed');
    }
  }
  return sent;
}

// ───────────── templates (inline-styled HTML + plain text) ─────────────

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
export const absoluteLink = (link: string | null) => (link ? (/^https?:\/\//.test(link) ? link : `${env.PUBLIC_URL.replace(/\/$/, '')}${link}`) : null);

function itemHtml(n: RenderedNotification) {
  const href = absoluteLink(n.link);
  const subject = href
    ? `<a href="${esc(href)}" style="color:#4f46e5;text-decoration:none;font-weight:600">${esc(n.subject)}</a>`
    : `<span style="font-weight:600">${esc(n.subject)}</span>`;
  return `<tr><td style="padding:12px 0;border-bottom:1px solid #e5e7eb">
    <div style="font-size:13px;color:#6b7280;margin-bottom:2px">${esc(n.headline)}</div>
    <div style="font-size:15px;color:#111827">${subject}</div>
    ${n.body ? `<div style="font-size:14px;color:#374151;margin-top:6px;white-space:pre-wrap">${esc(n.body)}</div>` : ''}
  </td></tr>`;
}

function layout(title: string, inner: string, footer: string) {
  return `<!doctype html><html><body style="margin:0;padding:0;background:#f3f4f6;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f3f4f6;padding:24px 0"><tr><td align="center">
<table role="presentation" width="560" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%;background:#ffffff;border-radius:8px;border:1px solid #e5e7eb">
<tr><td style="padding:20px 24px 8px 24px;font-size:16px;font-weight:600;color:#111827">${esc(title)}</td></tr>
<tr><td style="padding:0 24px 8px 24px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0">${inner}</table></td></tr>
<tr><td style="padding:12px 24px 20px 24px;font-size:12px;color:#9ca3af">${footer}</td></tr>
</table></td></tr></table></body></html>`;
}

const prefsFooter = () => `You can change which emails you get in <a href="${esc(`${env.PUBLIC_URL.replace(/\/$/, '')}/settings`)}" style="color:#6b7280">Settings</a>.`;

function itemText(n: RenderedNotification) {
  const href = absoluteLink(n.link);
  return [n.headline, n.subject, n.body ?? '', href ?? ''].filter(Boolean).join('\n');
}

export function instantEmail(n: RenderedNotification) {
  const subject = n.eventType === 'admin_alert' ? `[Admin] ${n.subject}` : `${n.headline}: ${n.subject}`;
  return {
    subject: subject.slice(0, 200),
    html: layout(n.headline, itemHtml(n), prefsFooter()),
    text: `${itemText(n)}\n\n--\nChange your email settings: ${env.PUBLIC_URL.replace(/\/$/, '')}/settings`,
  };
}

export function digestEmail(items: RenderedNotification[], mode: 'hourly' | 'daily') {
  const title = `${items.length} new notification${items.length === 1 ? '' : 's'}`;
  return {
    subject: `${mode === 'daily' ? 'Daily' : 'Hourly'} digest: ${title}`,
    html: layout(title, items.map(itemHtml).join(''), prefsFooter()),
    text: `${items.map(itemText).join('\n\n')}\n\n--\nChange your email settings: ${env.PUBLIC_URL.replace(/\/$/, '')}/settings`,
  };
}

// ───────────── digests ─────────────

/**
 * Job: hourly digests flush items created before the current hour; daily digests flush items
 * created before 08:00 user-local once it's past 08:00. Every item is re-checked for access now.
 * Items are claimed by setting emailed_at atomically, so they're never sent twice.
 */
export async function runDigests(now = new Date()) {
  if (!(await smtpSettings())) return 0;
  const wsTz = (await workspaceTimezone()) ?? DEFAULT_TZ;
  const recipients = await db.select().from(users)
    .where(and(eq(users.isActive, true), eq(users.isSystem, false), eq(users.isPlaceholder, false)));
  let emails = 0;
  for (const u of recipients) {
    const { matrix } = await userPrefs(u.id);
    const tz = u.timezone ?? wsTz;
    for (const mode of ['hourly', 'daily'] as const) {
      const types = Object.entries(matrix).filter(([, c]) => c.email.enabled && c.email.digest === mode).map(([e]) => e);
      if (!types.length) continue;
      let cutoff: Date;
      if (mode === 'hourly') cutoff = new Date(Math.floor(now.getTime() / 3_600_000) * 3_600_000);
      else {
        cutoff = new Date(startOfDay(now, tz).getTime() + 8 * 3_600_000);
        if (now < cutoff) continue;
      }
      const claimed = await db.update(notifications).set({ emailedAt: now })
        .where(and(
          eq(notifications.userId, u.id), isNull(notifications.emailedAt), inArray(notifications.eventType, types),
          lt(notifications.createdAt, cutoff), gt(notifications.createdAt, new Date(now.getTime() - 7 * 86_400_000)),
        )).returning();
      if (!claimed.length) continue;
      const access = await accessForUser(u.id);
      if (!access) continue;
      const items = (await renderNotifications(claimed.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime()), access, tz)).filter((n) => !n.redacted);
      if (!items.length) continue;
      await enqueueEmail({ userId: u.id, to: u.email, ...digestEmail(items, mode) });
      emails++;
    }
  }
  return emails;
}
