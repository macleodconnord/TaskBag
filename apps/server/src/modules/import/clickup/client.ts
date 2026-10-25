import { Readable } from 'node:stream';
import type { z } from 'zod';
import { getIntegrationConfig } from '../../../lib/integration-config';
import { log } from '../../../lib/log';
import {
  cuCommentsResponse, cuDocsResponse, cuFieldsResponse, cuFoldersResponse, cuGroupsResponse, cuListSchema, cuListsResponse,
  cuMembersResponse, cuPagesResponse, cuSpacesResponse, cuTaskSchema, cuTasksResponse, cuTeamsResponse, cuViewsResponse,
  type CuComment, type CuDoc, type CuField, type CuFolder, type CuList, type CuPage, type CuSpace, type CuTask, type CuUser, type CuView,
} from './schemas';

export type CuLocation = { type: 'team' | 'space' | 'folder' | 'list'; id: string };

export interface ClientStats {
  requests: number;
  /** X-RateLimit-Remaining from the last response */
  remaining: number | null;
  /** epoch ms from X-RateLimit-Reset */
  resetAt: number | null;
  limit: number | null;
  throttledMs: number;
  retries: number;
}

export interface Download {
  stream: NodeJS.ReadableStream;
  contentType: string | null;
  size: number | null;
}

/** Everything the importer reads from ClickUp. Implemented over HTTP below and by a fixture-fed fake in tests. */
export interface ClickUpApi {
  readonly teamId: string;
  getWorkspace(): Promise<{ id: string; name: string; members: CuUser[] }>;
  getGroups(): Promise<Array<{ id: string; name: string; members: CuUser[] }>>;
  getSpaces(archived: boolean): Promise<CuSpace[]>;
  getFolders(spaceId: string, archived: boolean): Promise<CuFolder[]>;
  getFolderLists(folderId: string, archived: boolean): Promise<CuList[]>;
  getFolderlessLists(spaceId: string, archived: boolean): Promise<CuList[]>;
  getList(listId: string): Promise<CuList>;
  getListMembers(listId: string): Promise<CuUser[]>;
  /** one page (100) of tasks incl. closed tasks and subtasks */
  getTasks(listId: string, page: number, opts: { archived: boolean; updatedSince?: Date | null }): Promise<{ tasks: CuTask[]; lastPage: boolean }>;
  getTask(taskId: string): Promise<CuTask>;
  /** all top-level comments of a task, oldest first */
  getComments(taskId: string): Promise<CuComment[]>;
  getReplies(commentId: string): Promise<CuComment[]>;
  getFields(loc: CuLocation): Promise<CuField[]>;
  getViews(loc: CuLocation): Promise<CuView[]>;
  getDocs(): Promise<CuDoc[]>;
  getDocPages(docId: string): Promise<CuPage[]>;
  download(url: string): Promise<Download>;
  stats(): ClientStats;
}

export class ClickUpError extends Error {
  constructor(public status: number, message: string, public path: string) {
    super(message);
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const BASE = 'https://api.clickup.com/api';

/**
 * ClickUp REST client. Budgeted at `rpm` requests/minute (default 90; the Business plan limit is 100),
 * adapting to X-RateLimit-Remaining / X-RateLimit-Reset, and backing off on 429 and 5xx.
 */
export class HttpClickUpClient implements ClickUpApi {
  private nextSlot = 0;
  private s: ClientStats = { requests: 0, remaining: null, resetAt: null, limit: null, throttledMs: 0, retries: 0 };
  private readonly minInterval: number;

  constructor(private token: string, readonly teamId: string, opts: { rpm?: number; baseUrl?: string } = {}) {
    this.minInterval = Math.ceil(60_000 / (opts.rpm ?? 90));
    if (opts.baseUrl) this.base = opts.baseUrl;
  }
  private base = BASE;

  stats() {
    return { ...this.s };
  }

  private async throttle() {
    const now = Date.now();
    let interval = this.minInterval;
    const { remaining, resetAt } = this.s;
    if (remaining !== null && resetAt && resetAt > now) {
      // spread what is left of the window evenly, keeping a small reserve for other ClickUp users
      if (remaining <= 3) interval = Math.max(interval, resetAt - now + 250);
      else interval = Math.max(interval, Math.ceil((resetAt - now) / (remaining - 3)));
    }
    const at = Math.max(now, this.nextSlot);
    this.nextSlot = at + interval;
    const wait = at - now;
    if (wait > 0) {
      this.s.throttledMs += wait;
      await sleep(wait);
    }
  }

  private readHeaders(res: Response) {
    const rem = res.headers.get('x-ratelimit-remaining');
    const reset = res.headers.get('x-ratelimit-reset');
    const limit = res.headers.get('x-ratelimit-limit');
    if (rem !== null && rem !== '') this.s.remaining = Number(rem);
    if (limit !== null && limit !== '') this.s.limit = Number(limit);
    if (reset) {
      const n = Number(reset);
      // seconds since epoch (documented) — tolerate ms
      this.s.resetAt = n > 1e12 ? n : n * 1000;
    }
  }

  async request<S extends z.ZodType>(path: string, schema: S, opts: { v3?: boolean; query?: Record<string, string | number | boolean | undefined | null> } = {}): Promise<z.infer<S>> {
    const url = new URL(`${this.base}/${opts.v3 ? 'v3' : 'v2'}${path}`);
    for (const [k, v] of Object.entries(opts.query ?? {})) if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    for (let attempt = 0; ; attempt++) {
      await this.throttle();
      this.s.requests++;
      let res: Response;
      try {
        res = await fetch(url, { headers: { authorization: this.token, accept: 'application/json' }, signal: AbortSignal.timeout(60_000) });
      } catch (err) {
        if (attempt >= 4) throw new ClickUpError(0, `ClickUp request failed: ${(err as Error).message}`, path);
        this.s.retries++;
        await sleep(2 ** attempt * 1000);
        continue;
      }
      this.readHeaders(res);
      if (res.status === 429) {
        if (attempt >= 8) throw new ClickUpError(429, 'ClickUp rate limit: too many retries', path);
        const wait = this.s.resetAt && this.s.resetAt > Date.now() ? this.s.resetAt - Date.now() + 500 : Math.min(60_000, 2 ** attempt * 2000);
        log.warn({ path, wait }, 'clickup 429, backing off');
        this.s.retries++;
        this.s.throttledMs += wait;
        await sleep(wait);
        continue;
      }
      if (res.status >= 500 && attempt < 4) {
        this.s.retries++;
        await sleep(2 ** attempt * 1500);
        continue;
      }
      const text = await res.text();
      if (!res.ok) {
        let msg = text.slice(0, 300);
        try {
          const j = JSON.parse(text) as { err?: string; ECODE?: string };
          if (j.err) msg = `${j.err}${j.ECODE ? ` (${j.ECODE})` : ''}`;
        } catch { /* not json */ }
        throw new ClickUpError(res.status, `ClickUp ${res.status} on ${path}: ${msg}`, path);
      }
      const json = text ? JSON.parse(text) : {};
      const parsed = schema.safeParse(json);
      if (!parsed.success) {
        const i = parsed.error.issues[0];
        throw new ClickUpError(res.status, `Unexpected ClickUp response for ${path}: ${i?.path.join('.')} ${i?.message}`, path);
      }
      return parsed.data;
    }
  }

  async getWorkspace() {
    const r = await this.request('/team', cuTeamsResponse);
    const t = r.teams.find((x) => x.id === this.teamId);
    if (!t) throw new ClickUpError(404, `Workspace ${this.teamId} is not visible to this API token (found: ${r.teams.map((x) => `${x.name} (${x.id})`).join(', ') || 'none'})`, '/team');
    return { id: t.id, name: t.name, members: t.members.map((m) => m.user) };
  }
  async getGroups() {
    try {
      return (await this.request('/group', cuGroupsResponse, { query: { team_id: this.teamId } })).groups;
    } catch (err) {
      // user groups need a paid plan / admin token; the import works without them
      if (err instanceof ClickUpError && (err.status === 401 || err.status === 403 || err.status === 404)) return [];
      throw err;
    }
  }
  async getSpaces(archived: boolean) {
    return (await this.request(`/team/${this.teamId}/space`, cuSpacesResponse, { query: { archived } })).spaces;
  }
  async getFolders(spaceId: string, archived: boolean) {
    return (await this.request(`/space/${spaceId}/folder`, cuFoldersResponse, { query: { archived } })).folders;
  }
  async getFolderLists(folderId: string, archived: boolean) {
    return (await this.request(`/folder/${folderId}/list`, cuListsResponse, { query: { archived } })).lists;
  }
  async getFolderlessLists(spaceId: string, archived: boolean) {
    return (await this.request(`/space/${spaceId}/list`, cuListsResponse, { query: { archived } })).lists;
  }
  async getList(listId: string) {
    return this.request(`/list/${listId}`, cuListSchema);
  }
  async getListMembers(listId: string) {
    return (await this.request(`/list/${listId}/member`, cuMembersResponse)).members;
  }
  async getTasks(listId: string, page: number, opts: { archived: boolean; updatedSince?: Date | null }) {
    const r = await this.request(`/list/${listId}/task`, cuTasksResponse, {
      query: {
        page, archived: opts.archived, include_closed: true, subtasks: true, include_markdown_description: true,
        date_updated_gt: opts.updatedSince ? opts.updatedSince.getTime() : undefined,
      },
    });
    return { tasks: r.tasks, lastPage: r.last_page ?? r.tasks.length < 100 };
  }
  async getTask(taskId: string) {
    return this.request(`/task/${taskId}`, cuTaskSchema, { query: { include_markdown_description: true } });
  }
  async getComments(taskId: string) {
    const out: CuComment[] = [];
    const seen = new Set<string>();
    let start: { date: number; id: string } | null = null;
    // newest 25 per call; page backwards with start/start_id
    for (let i = 0; i < 400; i++) {
      const r: z.infer<typeof cuCommentsResponse> = await this.request(`/task/${taskId}/comment`, cuCommentsResponse, { query: start ? { start: start.date, start_id: start.id } : {} });
      const fresh = r.comments.filter((c) => !seen.has(c.id));
      for (const c of fresh) { seen.add(c.id); out.push(c); }
      if (r.comments.length < 25 || !fresh.length) break;
      const oldest: CuComment = r.comments[r.comments.length - 1];
      start = { date: oldest.date ?? 0, id: oldest.id };
    }
    return out.sort((a, b) => (a.date ?? 0) - (b.date ?? 0));
  }
  async getReplies(commentId: string) {
    const r = await this.request(`/comment/${commentId}/reply`, cuCommentsResponse);
    return r.comments.sort((a, b) => (a.date ?? 0) - (b.date ?? 0));
  }
  async getFields(loc: CuLocation) {
    const path = loc.type === 'team' ? `/team/${loc.id}/field` : `/${loc.type}/${loc.id}/field`;
    try {
      return (await this.request(path, cuFieldsResponse)).fields;
    } catch (err) {
      // workspace/space/folder field endpoints are newer; fall back to list-level discovery
      if (err instanceof ClickUpError && err.status === 404 && loc.type !== 'list') return [];
      throw err;
    }
  }
  async getViews(loc: CuLocation) {
    return (await this.request(`/${loc.type}/${loc.id}/view`, cuViewsResponse)).views;
  }
  async getDocs() {
    const out: CuDoc[] = [];
    let cursor: string | null | undefined;
    for (let i = 0; i < 200; i++) {
      const r = await this.request(`/workspaces/${this.teamId}/docs`, cuDocsResponse, { v3: true, query: { cursor: cursor ?? undefined, deleted: false } });
      out.push(...r.docs);
      cursor = r.next_cursor;
      if (!cursor || !r.docs.length) break;
    }
    return out;
  }
  async getDocPages(docId: string) {
    return this.request(`/workspaces/${this.teamId}/docs/${docId}/pages`, cuPagesResponse, {
      v3: true, query: { max_page_depth: -1, content_format: 'text/md' },
    });
  }
  async download(url: string): Promise<Download> {
    // attachment hosts are not API-rate-limited; send the token only to ClickUp's own hosts, and only if needed
    let res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(10 * 60_000) });
    const host = new URL(url).hostname;
    if ((res.status === 401 || res.status === 403) && /(^|\.)clickup(-attachments)?\.com$/.test(host)) {
      res = await fetch(url, { headers: { authorization: this.token }, redirect: 'follow', signal: AbortSignal.timeout(10 * 60_000) });
    }
    if (!res.ok || !res.body) throw new ClickUpError(res.status, `Download failed (${res.status})`, url);
    const len = res.headers.get('content-length');
    return {
      stream: Readable.fromWeb(res.body as never),
      contentType: res.headers.get('content-type'),
      size: len ? Number(len) : null,
    };
  }
}

export interface ClickUpCredentials {
  token: string | null;
  teamId: string | null;
  /** where the values came from */
  source: 'settings' | 'env' | null;
  enabled: boolean;
}

/** Token + workspace id from Admin → Integrations (`clickup`), falling back to CLICKUP_API_TOKEN / CLICKUP_TEAM_ID. */
export async function clickupCredentials(): Promise<ClickUpCredentials> {
  const cfg = await getIntegrationConfig('clickup');
  const token = cfg.secrets.apiToken || null;
  const teamId = (cfg.config.teamId ? String(cfg.config.teamId) : '') || null;
  if (token && teamId) return { token, teamId, source: 'settings', enabled: cfg.enabled };
  const envToken = process.env.CLICKUP_API_TOKEN || null;
  const envTeam = process.env.CLICKUP_TEAM_ID || null;
  if (envToken && envTeam) return { token: envToken, teamId: envTeam, source: 'env', enabled: true };
  return { token, teamId, source: null, enabled: cfg.enabled };
}

/** Test hook: lets tests (and the CLI) inject a fake client. */
let clientFactory: (() => Promise<ClickUpApi>) | null = null;
export const setClickUpClientFactory = (f: (() => Promise<ClickUpApi>) | null) => { clientFactory = f; };

export async function createClickUpClient(): Promise<ClickUpApi> {
  if (clientFactory) return clientFactory();
  const c = await clickupCredentials();
  if (!c.token || !c.teamId) throw new Error('ClickUp is not configured: set the API token and workspace ID in Admin → Integrations');
  return new HttpClickUpClient(c.token, c.teamId);
}
