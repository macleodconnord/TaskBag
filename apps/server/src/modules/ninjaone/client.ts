import { NINJA_REGIONS } from '@app/shared';

/**
 * NinjaOne public API client — READ-ONLY by construction (architecture §9.3 rule 7).
 *
 * Every request goes through `call()`, which checks an explicit allow-list: GETs on the ticketing
 * read endpoints, plus `POST /v2/ticketing/trigger/board/{id}/run` (a read). Anything else throws
 * `NinjaWriteBlocked` before any network I/O. Only the OAuth token request bypasses it (it's not
 * an API call). This file must not import the DB or env so it stays unit-testable.
 */

type Method = 'GET' | 'POST';
export const NINJA_ALLOW_LIST: ReadonlyArray<{ method: Method; path: RegExp }> = Object.freeze([
  { method: 'GET', path: /^\/v2\/ticketing\/trigger\/boards$/ },
  { method: 'POST', path: /^\/v2\/ticketing\/trigger\/board\/\d+\/run$/ },
  { method: 'GET', path: /^\/v2\/ticketing\/ticket\/\d+$/ },
  { method: 'GET', path: /^\/v2\/ticketing\/ticket\/\d+\/log-entry$/ },
  { method: 'GET', path: /^\/v2\/ticketing\/statuses$/ },
  { method: 'GET', path: /^\/v2\/ticketing\/attributes$/ },
  { method: 'GET', path: /^\/v2\/ticketing\/ticket-form$/ },
  { method: 'GET', path: /^\/v2\/organizations$/ },
]);

export class NinjaWriteBlocked extends Error {
  constructor(method: string, path: string) {
    super(`NinjaOne client is read-only: ${method} ${path} is not allow-listed`);
  }
}

export const isAllowed = (method: string, path: string) =>
  NINJA_ALLOW_LIST.some((a) => a.method === method && a.path.test(path));

export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal }) =>
  Promise<{ ok: boolean; status: number; headers: { get(name: string): string | null }; text(): Promise<string> }>;

export interface NinjaClientOptions {
  region: string;
  clientId: string;
  clientSecret: string;
  scope?: string;
  fetch?: FetchLike;
  /** token bucket: requests per second (default 5) */
  ratePerSec?: number;
  maxRetries?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

/** A row from a board run (columns vary by board) or a ticket detail. */
export type NinjaTicket = Record<string, unknown> & { id: number };
export interface NinjaLogEntry {
  id: number | string;
  type?: string;
  publicEntry?: boolean;
  body?: string;
  htmlBody?: string;
  createTime?: number | string;
  appUserContactUid?: string;
  [k: string]: unknown;
}

export interface BoardPage {
  tickets: NinjaTicket[];
  lastCursorId: unknown;
}

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class NinjaClient {
  readonly host: string;
  private token: { value: string; expiresAt: number } | null = null;
  private tokens: number;
  private lastRefill: number;
  private readonly rate: number;
  private readonly fetchFn: FetchLike;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  /** number of API calls made (for stats) */
  calls = 0;

  constructor(private opts: NinjaClientOptions) {
    const host = (NINJA_REGIONS as Record<string, string>)[opts.region];
    if (!host) throw new Error(`Unknown NinjaOne region "${opts.region}"`);
    this.host = host;
    this.rate = opts.ratePerSec ?? 5;
    this.tokens = this.rate;
    this.fetchFn = opts.fetch ?? (globalThis.fetch as unknown as FetchLike);
    this.sleep = opts.sleep ?? realSleep;
    this.now = opts.now ?? Date.now;
    this.lastRefill = this.now();
  }

  // ───────────── public, read-only surface ─────────────

  /** Fetch an access token (also the "is the secret accepted" test). */
  async authenticate(): Promise<{ scope: string; expiresIn: number }> {
    const t = await this.accessToken(true);
    return { scope: this.opts.scope ?? 'monitoring', expiresIn: Math.round((t.expiresAt - this.now()) / 1000) };
  }

  listBoards() {
    return this.call<Array<{ id: number; name: string; [k: string]: unknown }>>('GET', '/v2/ticketing/trigger/boards');
  }

  /** One page of a board run. `lastCursorId` is opaque (its type differs between sources). */
  async runBoard(boardId: number, opts: { pageSize?: number; lastCursorId?: unknown } = {}): Promise<BoardPage> {
    const body: Record<string, unknown> = { pageSize: opts.pageSize ?? 100 };
    if (opts.lastCursorId !== undefined && opts.lastCursorId !== null) body.lastCursorId = opts.lastCursorId;
    const res = await this.call<Record<string, unknown> | NinjaTicket[]>('POST', `/v2/ticketing/trigger/board/${Number(boardId)}/run`, body);
    if (Array.isArray(res)) return { tickets: res, lastCursorId: undefined };
    const tickets = (Array.isArray(res.data) ? res.data : Array.isArray(res.tickets) ? res.tickets : []) as NinjaTicket[];
    const meta = (res.metadata ?? {}) as Record<string, unknown>;
    return { tickets, lastCursorId: res.lastCursorId ?? meta.lastCursorId };
  }

  /** Page through a whole board. Stops on a short page, an empty page or a repeated cursor. */
  async runWholeBoard(boardId: number, pageSize = 100, maxPages = 500): Promise<NinjaTicket[]> {
    const all: NinjaTicket[] = [];
    const seen = new Set<number>();
    let cursor: unknown;
    for (let i = 0; i < maxPages; i++) {
      const page = await this.runBoard(boardId, { pageSize, lastCursorId: cursor });
      let fresh = 0;
      for (const t of page.tickets) {
        const id = Number(t.id);
        if (!Number.isFinite(id) || seen.has(id)) continue;
        seen.add(id);
        all.push(t);
        fresh++;
      }
      const next = page.lastCursorId ?? page.tickets.at(-1)?.id;
      if (page.tickets.length < pageSize || fresh === 0 || next === undefined || JSON.stringify(next) === JSON.stringify(cursor)) break;
      cursor = next;
    }
    return all;
  }

  getTicket(ticketId: number) {
    return this.call<NinjaTicket>('GET', `/v2/ticketing/ticket/${Number(ticketId)}`);
  }

  async getLogEntries(ticketId: number): Promise<NinjaLogEntry[]> {
    const res = await this.call<NinjaLogEntry[] | { data?: NinjaLogEntry[] }>('GET', `/v2/ticketing/ticket/${Number(ticketId)}/log-entry`);
    return Array.isArray(res) ? res : res.data ?? [];
  }

  listStatuses() {
    return this.call<Array<Record<string, unknown>>>('GET', '/v2/ticketing/statuses');
  }
  listAttributes() {
    return this.call<Array<Record<string, unknown>>>('GET', '/v2/ticketing/attributes');
  }
  listForms() {
    return this.call<Array<Record<string, unknown>>>('GET', '/v2/ticketing/ticket-form');
  }
  listOrganizations() {
    return this.call<Array<{ id: number; name: string }>>('GET', '/v2/organizations');
  }

  // ───────────── internals ─────────────

  private async accessToken(force = false) {
    if (!force && this.token && this.token.expiresAt - 60_000 > this.now()) return this.token;
    const body = new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: this.opts.clientId,
      client_secret: this.opts.clientSecret,
      scope: this.opts.scope ?? 'monitoring',
    }).toString();
    await this.throttle();
    const res = await this.fetchFn(`https://${this.host}/ws/oauth/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body,
      signal: AbortSignal.timeout(20_000),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`NinjaOne token request failed (${res.status}): ${safeExcerpt(text)}`);
    const json = JSON.parse(text) as { access_token?: string; expires_in?: number };
    if (!json.access_token) throw new Error('NinjaOne token response had no access_token');
    this.token = { value: json.access_token, expiresAt: this.now() + (json.expires_in ?? 3600) * 1000 };
    return this.token;
  }

  /** Token bucket: `rate` requests per second, burst of `rate`. */
  private async throttle() {
    for (;;) {
      const t = this.now();
      this.tokens = Math.min(this.rate, this.tokens + ((t - this.lastRefill) / 1000) * this.rate);
      this.lastRefill = t;
      if (this.tokens >= 1) {
        this.tokens -= 1;
        return;
      }
      await this.sleep(Math.ceil(((1 - this.tokens) / this.rate) * 1000));
    }
  }

  private async call<T>(method: Method, path: string, body?: unknown): Promise<T> {
    if (!isAllowed(method, path)) throw new NinjaWriteBlocked(method, path);
    const maxRetries = this.opts.maxRetries ?? 5;
    for (let attempt = 0; ; attempt++) {
      const token = await this.accessToken();
      await this.throttle();
      this.calls++;
      const res = await this.fetchFn(`https://${this.host}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${token.value}`,
          accept: 'application/json',
          ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(30_000),
      });
      if (res.status === 401 && attempt === 0) {
        this.token = null;
        continue;
      }
      if ((res.status === 429 || res.status >= 500) && attempt < maxRetries) {
        const retryAfter = Number(res.headers.get('retry-after'));
        const wait = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : Math.min(60_000, 1000 * 2 ** attempt);
        await this.sleep(wait + Math.floor(Math.random() * 250));
        continue;
      }
      const text = await res.text();
      if (!res.ok) throw new Error(`NinjaOne ${method} ${path} failed (${res.status}): ${safeExcerpt(text)}`);
      return (text ? JSON.parse(text) : null) as T;
    }
  }
}

const safeExcerpt = (t: string) => t.replace(/\s+/g, ' ').slice(0, 300);
