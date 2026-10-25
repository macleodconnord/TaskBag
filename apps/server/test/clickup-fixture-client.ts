import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import type { z } from 'zod';
import { HttpClickUpClient, type Download } from '../src/modules/import/clickup/client';

type Recording = Record<string, unknown> & { _downloads: Record<string, string> };
type Task = { id: string; date_updated?: string | number | null; [k: string]: unknown };

/** Query params that don't change which recorded response applies. */
const IGNORED = new Set(['include_closed', 'subtasks', 'include_markdown_description', 'date_updated_gt']);

export function loadRecording(): Recording {
  const file = resolve(dirname(fileURLToPath(import.meta.url)), 'fixtures/clickup/workspace.json');
  return JSON.parse(readFileSync(file, 'utf8')) as Recording;
}

/**
 * ClickUp client fed by the recorded fixture: the real client's endpoint, pagination and zod
 * parsing code runs, only the HTTP layer is replaced. Never touches the network.
 */
export class FixtureClickUpClient extends HttpClickUpClient {
  calls: string[] = [];

  constructor(public rec: Recording = loadRecording()) {
    super('fixture-token', '9011000001');
  }

  /** Every recorded task (across lists/pages), for edits in tests. */
  allTasks(): Task[] {
    return Object.entries(this.rec)
      .filter(([k]) => /^GET v2\/list\/[^/]+\/task\?/.test(k))
      .flatMap(([, v]) => (v as { tasks: Task[] }).tasks);
  }

  override async request<S extends z.ZodType>(path: string, schema: S, opts: { v3?: boolean; query?: Record<string, string | number | boolean | undefined | null> } = {}): Promise<z.infer<S>> {
    const q = Object.entries(opts.query ?? {}).filter(([k, v]) => v !== undefined && v !== null && !IGNORED.has(k)).sort(([a], [b]) => a.localeCompare(b));
    const key = `GET ${opts.v3 ? 'v3' : 'v2'}${path}${q.length ? `?${q.map(([k, v]) => `${k}=${v}`).join('&')}` : ''}`;
    this.calls.push(key);
    let body: unknown = structuredClone(this.rec[key]);
    const since = opts.query?.date_updated_gt;
    if (body && since && /^\/list\/[^/]+\/task$/.test(path)) {
      const b = body as { tasks: Task[] };
      b.tasks = b.tasks.filter((t) => Number(t.date_updated ?? 0) > Number(since));
    }
    if (body === undefined) {
      const task = /^\/task\/([^/]+)$/.exec(path);
      if (task) body = structuredClone(this.allTasks().find((t) => t.id === task[1]));
      else if (path.endsWith('/pages')) body = [];
      else body = { spaces: [], folders: [], lists: [], tasks: [], last_page: true, comments: [], fields: [], views: [], docs: [], members: [], groups: [] };
      if (body === undefined) throw new Error(`fixture: no recording for ${key}`);
    }
    return schema.parse(body);
  }

  override async download(url: string): Promise<Download> {
    const text = this.rec._downloads[url];
    if (text === undefined) throw new Error(`fixture: no download for ${url}`);
    const buf = Buffer.from(text);
    return { stream: Readable.from([buf]), contentType: 'text/plain', size: buf.length };
  }
}
