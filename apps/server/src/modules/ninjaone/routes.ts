import { ninjaMappingSchema } from '@app/shared';
import { and, asc, desc, eq, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { db } from '../../db/client';
import { integrationSyncLogs, lists, ninjaBoardMappings, ninjaSyncState, ninjaTickets, tasks } from '../../db/schema';
import { NotFound } from '../../lib/errors';
import { auth, parse, type Params } from '../../lib/http';
import { makeNinjaClient, ninjaSettings, ninjaTicketUrl, recentlySeenValues } from './store';
import { runPoll, runReconcile } from './service';

/** /api/integrations/ninjaone — admin: sync state, reconcile now, ticket → task mapping rules. */
export default async function ninjaoneRoutes(app: FastifyInstance) {
  app.addHook('preHandler', async (req) => auth(req).access.requireAdmin());

  app.get('/state', async () => {
    const s = await ninjaSettings();
    const [state] = await db.select().from(ninjaSyncState).where(eq(ninjaSyncState.id, 1));
    const [counts] = await db.select({
      tickets: sql<number>`count(*)::int`,
      linked: sql<number>`count(${ninjaTickets.taskId})::int`,
    }).from(ninjaTickets);
    const logs = await db.select().from(integrationSyncLogs)
      .where(and(eq(integrationSyncLogs.integrationKey, 'ninjaone'), sql`${integrationSyncLogs.jobName} in ('ninja.poll', 'ninja.reconcile')`))
      .orderBy(desc(integrationSyncLogs.startedAt)).limit(15);
    return {
      enabled: s.enabled,
      configured: !!(s.clientId && s.clientSecret),
      deltaBoardId: s.deltaBoardId ?? null,
      sourceBoardIds: s.sourceBoardIds,
      pollIntervalSec: s.pollIntervalSec,
      state: state ?? null,
      counts,
      logs,
    };
  });

  app.post('/reconcile', async (_req, reply) => {
    void runReconcile('manual').catch(() => undefined);
    return reply.code(202).send({ started: true });
  });

  app.post('/poll', async () => {
    try {
      return { ok: true, result: await runPoll() };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  app.get('/tickets', async () => {
    const s = await ninjaSettings();
    const rows = await db.select({ t: ninjaTickets, key: tasks.key, taskName: tasks.name })
      .from(ninjaTickets).leftJoin(tasks, eq(tasks.id, ninjaTickets.taskId))
      .orderBy(desc(ninjaTickets.lastPolledAt)).limit(50);
    return rows.map(({ t, key, taskName }) => {
      const snap = t.snapshot as Record<string, unknown>;
      return {
        ticketId: t.ticketId, boardId: t.boardId, subject: snap.__subject ?? null, status: snap.__status ?? null,
        lastPolledAt: t.lastPolledAt, taskKey: key, taskName, url: ninjaTicketUrl(s.region, t.ticketId),
      };
    });
  });

  /** Lookups from NinjaOne for building mapping rules (each part fails independently). */
  app.get('/meta', async () => {
    const s = await ninjaSettings();
    const out: Record<string, unknown> = { seen: await recentlySeenValues() };
    let client;
    try {
      client = makeNinjaClient(s);
    } catch (err) {
      return { ...out, error: (err as Error).message };
    }
    const errors: string[] = [];
    const grab = async (k: string, fn: () => Promise<unknown>) => {
      try {
        out[k] = await fn();
      } catch (err) {
        errors.push(`${k}: ${err instanceof Error ? err.message : String(err)}`);
      }
    };
    await grab('boards', () => client.listBoards());
    await grab('statuses', () => client.listStatuses());
    await grab('forms', () => client.listForms());
    await grab('organizations', () => client.listOrganizations());
    await grab('attributes', () => client.listAttributes());
    return { ...out, errors };
  });

  app.get('/mappings', async () => {
    const rows = await db.select({ m: ninjaBoardMappings, listName: lists.name })
      .from(ninjaBoardMappings).leftJoin(lists, eq(lists.id, ninjaBoardMappings.targetListId))
      .orderBy(asc(ninjaBoardMappings.position), asc(ninjaBoardMappings.createdAt));
    return rows.map(({ m, listName }) => ({ ...m, listName }));
  });

  app.post('/mappings', async (req) => {
    const input = parse(ninjaMappingSchema, req.body);
    await requireList(input.targetListId);
    const [row] = await db.insert(ninjaBoardMappings).values(input).returning();
    return row;
  });

  app.patch<{ Params: Params<'id'> }>('/mappings/:id', async (req) => {
    const input = parse(ninjaMappingSchema.partial(), req.body);
    if (input.targetListId) await requireList(input.targetListId);
    const [row] = await db.update(ninjaBoardMappings).set(input).where(eq(ninjaBoardMappings.id, req.params.id)).returning();
    if (!row) throw new NotFound();
    return row;
  });

  app.delete<{ Params: Params<'id'> }>('/mappings/:id', async (req) => {
    await db.delete(ninjaBoardMappings).where(eq(ninjaBoardMappings.id, req.params.id));
    return { ok: true };
  });
}

async function requireList(id: string) {
  const [l] = await db.select({ id: lists.id }).from(lists).where(eq(lists.id, id));
  if (!l) throw new NotFound('List not found');
}
