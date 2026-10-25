import { describe, expect, it } from 'vitest';
import { isAllowed, NINJA_ALLOW_LIST, NinjaClient, NinjaWriteBlocked, type FetchLike, type NinjaTicket } from '../src/modules/ninjaone/client';
import { NinjaSync, type ApplyResult, type NinjaStore, type NinjaSyncState, type NormalizedTicket } from '../src/modules/ninjaone/sync';

// ───────────── a fake NinjaOne tenant (no real HTTP) ─────────────

const DELTA_BOARD = 10;
const SOURCE_BOARD = 20;
const HOUR = 3600_000;

class FakeNinja {
  tickets = new Map<number, { id: number; subject: string; status: string; priority: string; lastUpdated: number }>();
  logEntries = new Map<number, Array<{ id: number; type: string; publicEntry: boolean; body: string; createTime: number }>>();
  calls: Array<{ method: string; path: string }> = [];
  constructor(public clock: { now: number }) {}

  update(id: number, patch: Partial<{ subject: string; status: string; priority: string }>) {
    const t = this.tickets.get(id) ?? { id, subject: `Ticket ${id}`, status: 'Open', priority: 'LOW', lastUpdated: 0 };
    this.tickets.set(id, { ...t, ...patch, lastUpdated: Math.floor(this.clock.now / 1000) });
  }

  /** delta board: "updated in the last 24h"; source board: everything */
  private board(id: number) {
    const all = [...this.tickets.values()].sort((a, b) => a.id - b.id);
    if (id === DELTA_BOARD) return all.filter((t) => this.clock.now - t.lastUpdated * 1000 <= 24 * HOUR);
    if (id === SOURCE_BOARD) return all;
    return [];
  }

  fetch: FetchLike = async (url, init) => {
    const u = new URL(url);
    this.calls.push({ method: init.method, path: u.pathname });
    const json = (status: number, body: unknown) => ({
      ok: status >= 200 && status < 300, status, headers: { get: () => null }, text: async () => JSON.stringify(body),
    });
    if (u.pathname === '/ws/oauth/token') {
      const params = new URLSearchParams(init.body ?? '');
      expect(params.get('scope')).toBe('monitoring');
      return json(200, { access_token: 'tok', expires_in: 3600 });
    }
    const run = /^\/v2\/ticketing\/trigger\/board\/(\d+)\/run$/.exec(u.pathname);
    if (run && init.method === 'POST') {
      const body = JSON.parse(init.body ?? '{}') as { pageSize: number; lastCursorId?: number };
      const rows = this.board(Number(run[1])).filter((t) => !body.lastCursorId || t.id > body.lastCursorId).slice(0, body.pageSize);
      return json(200, {
        data: rows.map((t) => ({ id: t.id, summary: t.subject, status: { name: t.status }, priority: t.priority, lastUpdated: t.lastUpdated })),
        metadata: { lastCursorId: rows.at(-1)?.id },
      });
    }
    const ticket = /^\/v2\/ticketing\/ticket\/(\d+)$/.exec(u.pathname);
    if (ticket) {
      const t = this.tickets.get(Number(ticket[1]));
      return t ? json(200, { id: t.id, subject: t.subject, status: { name: t.status }, description: { body: 'desc' } }) : json(404, {});
    }
    const log = /^\/v2\/ticketing\/ticket\/(\d+)\/log-entry$/.exec(u.pathname);
    if (log) return json(200, this.logEntries.get(Number(log[1])) ?? []);
    if (u.pathname === '/v2/ticketing/trigger/boards') return json(200, [{ id: DELTA_BOARD, name: 'Delta' }, { id: SOURCE_BOARD, name: 'All' }]);
    return json(404, { error: 'not found' });
  };
}

/** In-memory NinjaStore: the "task" is just the last applied status per ticket. */
class MemoryStore implements NinjaStore {
  state: NinjaSyncState = { lastSuccessfulPollAt: null, lastReconcileAt: null, reconcileRunning: false };
  hashes = new Map<number, string>();
  taskStatus = new Map<number, string | null>();
  applied: Array<{ id: number; status: string | null; boardId: number }> = [];
  async loadState() { return { ...this.state }; }
  async markPollSuccess(at: Date) { this.state.lastSuccessfulPollAt = at; }
  async tryBeginReconcile() {
    if (this.state.reconcileRunning) return false;
    this.state.reconcileRunning = true;
    return true;
  }
  async endReconcile(at: Date) {
    this.state.reconcileRunning = false;
    this.state.lastReconcileAt = at;
  }
  async getHashes(ids: number[]) { return new Map(ids.filter((i) => this.hashes.has(i)).map((i) => [i, this.hashes.get(i)!])); }
  async touch() {}
  async applyTicket(t: NormalizedTicket, hash: string): Promise<ApplyResult> {
    const existed = this.taskStatus.has(t.id);
    this.taskStatus.set(t.id, t.status);
    this.hashes.set(t.id, hash);
    this.applied.push({ id: t.id, status: t.status, boardId: t.boardId });
    return existed ? 'updated' : 'created';
  }
}

function setup(start = Date.UTC(2026, 9, 1, 12)) {
  const clock = { now: start };
  const ninja = new FakeNinja(clock);
  const client = new NinjaClient({ region: 'us', clientId: 'id', clientSecret: 'secret', fetch: ninja.fetch, sleep: async (ms) => { clock.now += ms; }, now: () => clock.now });
  const store = new MemoryStore();
  const sync = new NinjaSync(client, store, { deltaBoardId: DELTA_BOARD, sourceBoardIds: [SOURCE_BOARD], reconcileIfStaleHours: 20 }, () => new Date(clock.now));
  return { clock, ninja, client, store, sync };
}

// ───────────── read-only guarantee ─────────────

describe('NinjaOne client is read-only', () => {
  it('allow-list contains only GETs and the board-run POST', () => {
    for (const a of NINJA_ALLOW_LIST) {
      if (a.method === 'POST') expect(a.path.source).toBe('^\\/v2\\/ticketing\\/trigger\\/board\\/\\d+\\/run$');
      else expect(a.method).toBe('GET');
    }
    expect(isAllowed('POST', '/v2/ticketing/trigger/board/5/run')).toBe(true);
    expect(isAllowed('GET', '/v2/ticketing/ticket/5')).toBe(true);
    for (const [m, p] of [
      ['POST', '/v2/ticketing/ticket'], ['PUT', '/v2/ticketing/ticket/5'], ['PATCH', '/v2/ticketing/ticket/5'],
      ['DELETE', '/v2/ticketing/ticket/5'], ['POST', '/v2/ticketing/ticket/5/comment'], ['GET', '/v2/ticketing/ticket/5/../../devices'],
      ['POST', '/v2/ticketing/trigger/board/5/run/../../x'], ['GET', '/v2/devices'],
    ] as const) expect(isAllowed(m, p), `${m} ${p}`).toBe(false);
  });

  it('blocks non-allow-listed calls before any network I/O', async () => {
    const { client, ninja } = setup();
    const call = (client as unknown as { call: (m: string, p: string, b?: unknown) => Promise<unknown> }).call.bind(client);
    for (const [m, p] of [['PUT', '/v2/ticketing/ticket/1'], ['POST', '/v2/ticketing/ticket'], ['DELETE', '/v2/ticketing/ticket/1'], ['PATCH', '/v2/ticketing/ticket/1']]) {
      await expect(call(m, p, {})).rejects.toBeInstanceOf(NinjaWriteBlocked);
    }
    expect(ninja.calls).toEqual([]);
  });

  it('a full poll + reconcile only ever issues GETs, the board-run POST and the token request', async () => {
    const { ninja, sync, client } = setup();
    ninja.update(1, {});
    ninja.update(2, { status: 'In progress' });
    await sync.poll();
    await sync.reconcile();
    await client.listBoards();
    await client.getLogEntries(1);
    expect(ninja.calls.length).toBeGreaterThan(0);
    for (const c of ninja.calls) {
      const ok = c.path === '/ws/oauth/token' ? c.method === 'POST' : isAllowed(c.method, c.path);
      expect(ok, `${c.method} ${c.path}`).toBe(true);
    }
    // the client exposes no generic write method
    const proto = Object.getOwnPropertyNames(NinjaClient.prototype);
    expect(proto.filter((n) => /^(create|update|delete|put|patch|post|write|add|close)/i.test(n))).toEqual([]);
  });
});

// ───────────── poll / reconcile behaviour ─────────────

describe('NinjaOne poll and reconcile', () => {
  it('processes only hash-changed tickets', async () => {
    const { ninja, store, sync } = setup();
    ninja.update(1, {});
    ninja.update(2, {});
    expect(await sync.poll()).toMatchObject({ seen: 2, changed: 2, created: 2 });
    expect(await sync.poll()).toMatchObject({ seen: 2, changed: 0 });
    ninja.update(2, { status: 'Resolved' });
    expect(await sync.poll()).toMatchObject({ seen: 2, changed: 1, updated: 1 });
    expect(store.taskStatus.get(2)).toBe('Resolved');
  });

  it('pages through the whole delta board', async () => {
    const { ninja, sync } = setup();
    for (let i = 1; i <= 250; i++) ninja.update(i, {});
    const r = await sync.poll();
    expect(r).toMatchObject({ seen: 250, changed: 250 });
    expect(ninja.calls.filter((c) => c.path.endsWith('/run')).length).toBe(3);
  });

  it('a ticket leaving the delta board changes nothing', async () => {
    const { clock, ninja, store, sync } = setup();
    ninja.update(1, { status: 'Open' });
    await sync.poll();
    clock.now += 25 * HOUR; // ticket falls off the 24h delta board
    const applied = store.applied.length;
    expect(await sync.poll()).toMatchObject({ seen: 0, changed: 0 });
    expect(store.applied.length).toBe(applied);
    expect(store.taskStatus.get(1)).toBe('Open');
  });

  it('poll is skipped while a reconcile runs', async () => {
    const { ninja, store, sync } = setup();
    ninja.update(1, {});
    store.state.reconcileRunning = true;
    expect(await sync.poll()).toEqual({ skipped: 'reconcile running' });
    expect(await sync.reconcile()).toEqual({ skipped: 'reconcile already running' });
    expect(store.applied).toEqual([]);
  });

  it('30h outage: the missed change is invisible to the delta poll but caught by the startup reconcile', async () => {
    const { clock, ninja, store, sync } = setup();
    ninja.update(1, { status: 'Open' });
    ninja.update(2, { status: 'Open' });
    await sync.poll();
    expect(store.taskStatus.get(1)).toBe('Open');
    const lastPoll = store.state.lastSuccessfulPollAt!;

    // outage starts; 2h in, ticket 1 is resolved in NinjaOne
    clock.now += 2 * HOUR;
    ninja.update(1, { status: 'Resolved' });
    // … 28 more hours of outage (30h total): the change is now 28h old, outside the delta board's window
    clock.now += 28 * HOUR;

    expect(await sync.isStale()).toBe(true); // 30h > reconcileIfStaleHours (20h)

    // a plain delta poll would miss it
    const probe = await new NinjaSync(
      (sync as unknown as { client: NinjaClient }).client, store, { deltaBoardId: DELTA_BOARD }, () => new Date(clock.now),
    ).poll();
    expect(probe).toMatchObject({ seen: 0, changed: 0 });
    expect(store.taskStatus.get(1)).toBe('Open');

    // startup check → reconcile over the source boards catches it
    const r = await sync.reconcile();
    expect(r).toMatchObject({ seen: 2, changed: 1, updated: 1 });
    expect(store.taskStatus.get(1)).toBe('Resolved');
    expect(store.taskStatus.get(2)).toBe('Open');
    expect(store.state.reconcileRunning).toBe(false);
    expect(store.state.lastReconcileAt?.getTime()).toBe(clock.now);
    expect(store.state.lastSuccessfulPollAt!.getTime()).toBeGreaterThan(lastPoll.getTime());
    expect(await sync.isStale()).toBe(false);
  });

  it('reconcile releases the lock when it fails', async () => {
    const { ninja, store, sync } = setup();
    ninja.fetch = async () => { throw new Error('network down'); };
    const broken = new NinjaSync(
      new NinjaClient({ region: 'us', clientId: 'x', clientSecret: 'y', fetch: ninja.fetch, sleep: async () => {}, ratePerSec: 1e6 }),
      store, { sourceBoardIds: [SOURCE_BOARD] },
    );
    await expect(broken.reconcile()).rejects.toThrow('network down');
    expect(store.state.reconcileRunning).toBe(false);
  });

  it('retries 429 with backoff', async () => {
    const { ninja, client } = setup();
    let n = 0;
    const inner = ninja.fetch;
    const waits: number[] = [];
    const c = new NinjaClient({
      region: 'eu', clientId: 'x', clientSecret: 'y', ratePerSec: 1e6, sleep: async (ms) => { waits.push(ms); },
      fetch: async (url, init) => {
        if (url.includes('/boards') && n++ < 2) return { ok: false, status: 429, headers: { get: (h: string) => (h === 'retry-after' ? '2' : null) }, text: async () => '' };
        return inner(url, init);
      },
    });
    expect(c.host).toBe('eu.ninjarmm.com');
    expect(await c.listBoards()).toHaveLength(2);
    expect(waits.filter((w) => w >= 2000).length).toBe(2);
    expect(client.host).toBe('app.ninjarmm.com');
  });
});

export type { NinjaTicket };
