// UI smoke test: dev-login as a user, visit pages in system Chrome, report console/page errors and save screenshots.
// usage: node tools/ui-smoke.mjs [--base http://localhost:8080] [--role owner|admin|member|guest] [--scheme light|dark] [--out dir] [paths...]
import { chromium } from 'playwright-core';
import { mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf(`--${n}`); if (i < 0) return d; const v = args[i + 1]; args.splice(i, 2); return v; };
const base = opt('base', 'http://localhost:8080');
const role = opt('role', 'owner');
const out = opt('out', 'data/ui-smoke');
const scheme = opt('scheme', 'light'); // light | dark (users on the "system" theme follow it)
const paths = args.length ? args : ['/', '/search?q=import', '/everything', '/settings', '/admin/users', '/admin/groups'];
mkdirSync(out, { recursive: true });

const exe = ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', '/usr/bin/google-chrome'].find(existsSync);
const browser = await chromium.launch({ executablePath: exe, headless: true });
const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 }, colorScheme: scheme });
const page = await ctx.newPage();
const errors = [];
page.on('console', (m) => m.type() === 'error' && errors.push(`[console] ${page.url()} ${m.text()}`));
page.on('pageerror', (e) => errors.push(`[pageerror] ${page.url()} ${e.message}`));

const users = await (await ctx.request.get(`${base}/api/auth/dev-users`)).json();
const u = users.find((x) => x.role === role) ?? users[0];
const r = await ctx.request.post(`${base}/api/auth/dev-login`, { data: { userId: u.id } });
if (!r.ok()) throw new Error(`dev login failed: ${r.status()}`);

for (const p of paths) {
  await page.goto(base + p, { waitUntil: 'networkidle' }).catch((e) => errors.push(`[goto] ${p} ${e.message}`));
  await page.waitForTimeout(600);
  const file = join(out, `${scheme === 'dark' ? 'dark-' : ''}${role}-${p.replace(/[^a-z0-9]+/gi, '_') || 'root'}.png`);
  await page.screenshot({ path: file, fullPage: false });
  console.log(`ok ${p} -> ${file}`);
}
await browser.close();
if (errors.length) { console.log(`\n${errors.length} error(s):\n${errors.join('\n')}`); process.exit(1); }
console.log('\nno console errors');
