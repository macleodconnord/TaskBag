import {
  createFolderSchema, createListSchema, createSpaceSchema, saveSharingSchema, saveStatusSetSchema, updateFolderSchema,
  updateListSchema, updateSpaceSchema, type Level,
} from '@app/shared';
import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { db, type Tx } from '../../db/client';
import { docs, folders, groups, lists, spaces, statuses, statusSets, tasks, users, workspaces } from '../../db/schema';
import type { AccessContext, SecurableType } from '../../lib/access';
import { afterMove, dropScopesFor, getSharing, makePrivate, rootScopeId, setSharing, subtree } from '../../lib/acl';
import { Forbidden, NotFound, Validation } from '../../lib/errors';
import { auth, parse } from '../../lib/http';
import { runTx } from '../../lib/tx';
import { createStatusSet, listPath, statusesForList, statusSetIdForList } from './service';

type ListHook = (tx: Tx, list: typeof lists.$inferSelect, access: AccessContext) => Promise<Record<string, unknown>>;
const listDetailHooks: ListHook[] = [];
/** Extension point: add keys to GET /hierarchy/lists/:id (e.g. the List ↔ Task link breadcrumb). */
export const registerListDetailExtension = (fn: ListHook) => listDetailHooks.push(fn);

type ListCreateHook = (tx: Tx, list: typeof lists.$inferSelect, templateId: string, actorId: string) => Promise<void>;
let listFromTemplate: ListCreateHook | null = null;
/** Extension point: list templates fill a newly created list. */
export const setListFromTemplateHandler = (fn: ListCreateHook) => { listFromTemplate = fn; };

export default async function hierarchyRoutes(app: FastifyInstance) {
  // ── sidebar tree ──
  app.get('/tree', async (req) => {
    const { access } = auth(req);
    const { archived } = parse(z.object({ archived: z.enum(['true', 'false']).optional() }), req.query);
    const arch = archived === 'true';
    const [sp, fo, li] = await Promise.all([
      db.select().from(spaces).where(arch ? undefined : isNull(spaces.archivedAt)).orderBy(asc(spaces.position), asc(spaces.name)),
      db.select().from(folders).where(arch ? undefined : isNull(folders.archivedAt)).orderBy(asc(folders.position), asc(folders.name)),
      db.select().from(lists).where(arch ? undefined : isNull(lists.archivedAt)).orderBy(asc(lists.position), asc(lists.name)),
    ]);
    const lvl = async (scope: string) => access.levelOfScope(scope);
    // lists that hold a task shared with the user directly (guest "traverse" navigation)
    const viaTasks = new Set(
      (await db.selectDistinct({ id: tasks.listId }).from(tasks).where(and(isNull(tasks.deletedAt), await access.filter(tasks.aclScopeId)))).map((r) => r.id),
    );

    const listOut = [];
    for (const l of li) {
      const level = await lvl(l.aclScopeId);
      if (level === 'none' && !viaTasks.has(l.id)) continue;
      listOut.push({ id: l.id, name: l.name, spaceId: l.spaceId, folderId: l.folderId, position: l.position, archivedAt: l.archivedAt, navOnly: level === 'none', _perms: { level } });
    }
    const neededFolders = new Set(listOut.map((l) => l.folderId).filter(Boolean));
    const folderOut = [];
    for (const f of fo) {
      const level = await lvl(f.aclScopeId);
      if (level === 'none' && !neededFolders.has(f.id)) continue;
      folderOut.push({ id: f.id, name: f.name, spaceId: f.spaceId, position: f.position, archivedAt: f.archivedAt, navOnly: level === 'none', _perms: { level }, lists: listOut.filter((l) => l.folderId === f.id) });
    }
    const neededSpaces = new Set([...listOut.map((l) => l.spaceId), ...folderOut.map((f) => f.spaceId)]);
    const out = [];
    for (const s of sp) {
      const level = await lvl(s.aclScopeId);
      if (level === 'none' && !neededSpaces.has(s.id)) continue;
      out.push({
        id: s.id, name: s.name, color: s.color, keyPrefix: s.keyPrefix, position: s.position, archivedAt: s.archivedAt,
        navOnly: level === 'none', _perms: { level },
        folders: folderOut.filter((f) => f.spaceId === s.id),
        lists: listOut.filter((l) => l.spaceId === s.id && !l.folderId),
      });
    }
    return { spaces: out, canCreateSpace: !access.isGuest };
  });

  // ── spaces ──
  app.get<{ Params: { id: string } }>('/spaces/:id', async (req) => {
    const { access } = auth(req);
    const level = await access.require('view', 'space', req.params.id);
    const [s] = await db.select().from(spaces).where(eq(spaces.id, req.params.id));
    const sts = await db.select().from(statuses).where(eq(statuses.statusSetId, s.statusSetId!)).orderBy(asc(statuses.position));
    return { ...s, statuses: sts, _perms: { level } };
  });

  app.post('/spaces', async (req) => {
    const { user, access } = auth(req);
    if (access.isGuest) throw new Forbidden('Guests cannot create spaces');
    const input = parse(createSpaceSchema, req.body);
    const space = await runTx(async (tx) => {
      const [ws] = await tx.select().from(workspaces).limit(1);
      const [{ n }] = await tx.select({ n: sql<number>`coalesce(max(position), -1)::int + 1` }).from(spaces);
      const [taken] = await tx.select({ id: spaces.id }).from(spaces).where(eq(spaces.keyPrefix, input.keyPrefix));
      if (taken) throw new Validation(`Key prefix ${input.keyPrefix} is already used by another space`);
      const [s] = await tx.insert(spaces).values({
        workspaceId: ws.id, name: input.name, keyPrefix: input.keyPrefix, color: input.color ?? '#6366f1',
        position: n, aclScopeId: await rootScopeId(tx),
      }).returning();
      const setId = await createStatusSet(tx, 'space', s.id);
      await tx.update(spaces).set({ statusSetId: setId }).where(eq(spaces.id, s.id));
      const rootLevel = await access.levelOfScope(await rootScopeId(tx));
      // members who can't edit at the workspace root still get a space of their own, private to them
      if (input.private || (rootLevel !== 'edit' && rootLevel !== 'full')) {
        await makePrivate(tx, 'space', s.id, user.id);
      }
      // a default list so the space is usable straight away
      const [l] = await tx.select({ s: spaces.aclScopeId }).from(spaces).where(eq(spaces.id, s.id));
      await tx.insert(lists).values({ spaceId: s.id, name: 'List', aclScopeId: l.s });
      return s;
    });
    return space;
  });

  app.patch<{ Params: { id: string } }>('/spaces/:id', async (req) => {
    const { access } = auth(req);
    const input = parse(updateSpaceSchema, req.body);
    await access.require(input.archived !== undefined ? 'manage' : 'edit', 'space', req.params.id);
    const [s] = await db.update(spaces).set({
      ...(input.name ? { name: input.name } : {}),
      ...(input.color !== undefined ? { color: input.color } : {}),
      ...(input.position !== undefined ? { position: input.position } : {}),
      ...(input.archived !== undefined ? { archivedAt: input.archived ? new Date() : null } : {}),
    }).where(eq(spaces.id, req.params.id)).returning();
    return s;
  });

  app.delete<{ Params: { id: string } }>('/spaces/:id', async (req) => {
    const { access } = auth(req);
    await access.require('delete', 'space', req.params.id);
    await runTx(async (tx) => {
      const sub = await subtree(tx, 'space', req.params.id);
      await dropScopesFor(tx, [...sub.spaces, ...sub.folders, ...sub.lists, ...sub.tasks, ...sub.docs]);
      if (sub.docs.length) await tx.delete(docs).where(inArray(docs.id, sub.docs));
      await tx.delete(spaces).where(eq(spaces.id, req.params.id));
    });
    return { ok: true };
  });

  // ── folders ──
  app.post('/folders', async (req) => {
    const { user, access } = auth(req);
    const input = parse(createFolderSchema, req.body);
    await access.require('create_child', 'space', input.spaceId);
    return runTx(async (tx) => {
      const [sp] = await tx.select().from(spaces).where(eq(spaces.id, input.spaceId));
      const [{ n }] = await tx.select({ n: sql<number>`coalesce(max(position), -1)::int + 1` }).from(folders).where(eq(folders.spaceId, sp.id));
      const [f] = await tx.insert(folders).values({ spaceId: sp.id, name: input.name, position: n, aclScopeId: sp.aclScopeId }).returning();
      if (input.private) await makePrivate(tx, 'folder', f.id, user.id);
      return f;
    });
  });

  app.patch<{ Params: { id: string } }>('/folders/:id', async (req) => {
    const { access } = auth(req);
    const input = parse(updateFolderSchema, req.body);
    await access.require(input.archived !== undefined ? 'manage' : 'edit', 'folder', req.params.id);
    const [f] = await db.update(folders).set({
      ...(input.name ? { name: input.name } : {}),
      ...(input.position !== undefined ? { position: input.position } : {}),
      ...(input.archived !== undefined ? { archivedAt: input.archived ? new Date() : null } : {}),
    }).where(eq(folders.id, req.params.id)).returning();
    return f;
  });

  app.delete<{ Params: { id: string } }>('/folders/:id', async (req) => {
    const { access } = auth(req);
    await access.require('delete', 'folder', req.params.id);
    await runTx(async (tx) => {
      const sub = await subtree(tx, 'folder', req.params.id);
      await dropScopesFor(tx, [...sub.folders, ...sub.lists, ...sub.tasks, ...sub.docs]);
      if (sub.docs.length) await tx.delete(docs).where(inArray(docs.id, sub.docs));
      await tx.delete(folders).where(eq(folders.id, req.params.id));
    });
    return { ok: true };
  });

  // ── lists ──
  app.get<{ Params: { id: string } }>('/lists/:id', async (req) => {
    const { access } = auth(req);
    const level = await access.levelOf('list', req.params.id);
    const [l] = await db.select().from(lists).where(eq(lists.id, req.params.id));
    if (!l) throw new NotFound('List not found');
    if (level === 'none') {
      // traverse: a user with a task shared inside may see the list's name only
      const [t] = await db.select({ id: tasks.id }).from(tasks)
        .where(and(eq(tasks.listId, l.id), isNull(tasks.deletedAt), await access.filter(tasks.aclScopeId))).limit(1);
      if (!t) throw new NotFound('List not found');
    }
    const extra: Record<string, unknown> = {};
    for (const h of listDetailHooks) Object.assign(extra, await h(db, l, access));
    return {
      ...l,
      path: await listPath(db, l.id),
      statuses: await statusesForList(db, l.id),
      hasOwnStatuses: !!l.statusSetId,
      navOnly: level === 'none',
      _perms: { level },
      ...extra,
    };
  });

  app.post('/lists', async (req) => {
    const { user, access } = auth(req);
    const input = parse(createListSchema, req.body);
    if (input.folderId) await access.require('create_child', 'folder', input.folderId);
    else await access.require('create_child', 'space', input.spaceId);
    return runTx(async (tx) => {
      let scope: string;
      if (input.folderId) {
        const [f] = await tx.select().from(folders).where(eq(folders.id, input.folderId));
        if (!f || f.spaceId !== input.spaceId) throw new Validation('Folder is not in that space');
        scope = f.aclScopeId;
      } else {
        const [s] = await tx.select().from(spaces).where(eq(spaces.id, input.spaceId));
        scope = s.aclScopeId;
      }
      const [{ n }] = await tx.select({ n: sql<number>`coalesce(max(position), -1)::int + 1` }).from(lists)
        .where(and(eq(lists.spaceId, input.spaceId), input.folderId ? eq(lists.folderId, input.folderId) : isNull(lists.folderId)));
      const [l] = await tx.insert(lists).values({ spaceId: input.spaceId, folderId: input.folderId ?? null, name: input.name, position: n, aclScopeId: scope }).returning();
      if (input.private) await makePrivate(tx, 'list', l.id, user.id);
      if (input.templateId) {
        if (!listFromTemplate) throw new Validation('List templates are not available');
        const [fresh] = await tx.select().from(lists).where(eq(lists.id, l.id));
        await listFromTemplate(tx, fresh, input.templateId, user.id);
      }
      return l;
    });
  });

  app.patch<{ Params: { id: string } }>('/lists/:id', async (req) => {
    const { access } = auth(req);
    const input = parse(updateListSchema, req.body);
    const id = req.params.id;
    await access.require(input.archived !== undefined || input.settings ? 'manage' : 'edit', 'list', id);
    const moving = input.spaceId !== undefined || input.folderId !== undefined;
    return runTx(async (tx) => {
      const [cur] = await tx.select().from(lists).where(eq(lists.id, id));
      const set: Partial<typeof lists.$inferInsert> = {};
      if (input.name) set.name = input.name;
      if (input.description !== undefined) set.description = input.description;
      if (input.position !== undefined) set.position = input.position;
      if (input.archived !== undefined) set.archivedAt = input.archived ? new Date() : null;
      if (input.settings) set.settings = { ...cur.settings, ...input.settings };
      if (moving) {
        const spaceId = input.spaceId ?? cur.spaceId;
        const folderId = input.folderId === undefined ? (input.spaceId && input.spaceId !== cur.spaceId ? null : cur.folderId) : input.folderId;
        if (folderId) {
          await access.require('create_child', 'folder', folderId, tx);
          const [f] = await tx.select().from(folders).where(eq(folders.id, folderId));
          if (f.spaceId !== spaceId) throw new Validation('Folder is not in that space');
        } else await access.require('create_child', 'space', spaceId, tx);
        if (spaceId !== cur.spaceId) {
          if (!cur.statusSetId) {
            // keep the old space's statuses by giving the list its own copy, mapped by position
            const old = await statusesForList(tx, id);
            const setId = await createStatusSet(tx, 'list', id, old.map((s) => ({ name: s.name, color: s.color, group: s.group })));
            const fresh = await tx.select().from(statuses).where(eq(statuses.statusSetId, setId)).orderBy(asc(statuses.position));
            for (const [i, s] of old.entries()) await tx.update(tasks).set({ statusId: fresh[i].id }).where(and(eq(tasks.listId, id), eq(tasks.statusId, s.id)));
            set.statusSetId = setId;
          }
          // tags are per space: drop tags from the old space
          await tx.execute(sql`delete from task_tags where task_id in (select id from tasks where list_id = ${id})
            and tag_id in (select id from tags where space_id = ${cur.spaceId})`);
        }
        set.spaceId = spaceId;
        set.folderId = folderId;
      }
      const [l] = await tx.update(lists).set(set).where(eq(lists.id, id)).returning();
      if (moving) await afterMove(tx, 'list', id, cur.aclScopeId);
      return l;
    });
  });

  app.delete<{ Params: { id: string } }>('/lists/:id', async (req) => {
    const { access } = auth(req);
    await access.require('delete', 'list', req.params.id);
    await runTx(async (tx) => {
      const sub = await subtree(tx, 'list', req.params.id);
      await dropScopesFor(tx, [...sub.lists, ...sub.tasks, ...sub.docs]);
      if (sub.docs.length) await tx.delete(docs).where(inArray(docs.id, sub.docs));
      await tx.delete(lists).where(eq(lists.id, req.params.id));
    });
    return { ok: true };
  });

  // ── statuses ──
  app.put<{ Params: { id: string } }>('/spaces/:id/statuses', async (req) => {
    const { access } = auth(req);
    await access.require('manage', 'space', req.params.id);
    const input = parse(saveStatusSetSchema, req.body);
    await runTx(async (tx) => {
      const [s] = await tx.select().from(spaces).where(eq(spaces.id, req.params.id));
      await saveStatuses(tx, s.statusSetId!, input, null);
    });
    return { ok: true };
  });

  app.put<{ Params: { id: string } }>('/lists/:id/statuses', async (req) => {
    const { access } = auth(req);
    await access.require('manage', 'list', req.params.id);
    const input = parse(saveStatusSetSchema, req.body);
    await runTx(async (tx) => {
      const [l] = await tx.select().from(lists).where(eq(lists.id, req.params.id));
      if (l.statusSetId) return saveStatuses(tx, l.statusSetId, input, null);
      // first override: copy into a new set; input ids refer to the inherited statuses
      const [set] = await tx.insert(statusSets).values({ ownerType: 'list', ownerId: l.id }).returning();
      await tx.update(lists).set({ statusSetId: set.id }).where(eq(lists.id, l.id));
      await saveStatuses(tx, set.id, input, l.id);
    });
    return { ok: true };
  });

  /** Drop a list's own statuses and go back to the space's; `mapping` maps old → space status ids. */
  app.delete<{ Params: { id: string } }>('/lists/:id/statuses', async (req) => {
    const { access } = auth(req);
    await access.require('manage', 'list', req.params.id);
    const { mapping } = parse(z.object({ mapping: z.record(z.string(), z.string()).default({}) }), req.body ?? {});
    await runTx(async (tx) => {
      const [l] = await tx.select().from(lists).where(eq(lists.id, req.params.id));
      if (!l.statusSetId) return;
      const own = await tx.select().from(statuses).where(eq(statuses.statusSetId, l.statusSetId));
      const [sp] = await tx.select().from(spaces).where(eq(spaces.id, l.spaceId));
      const target = await tx.select().from(statuses).where(eq(statuses.statusSetId, sp.statusSetId!)).orderBy(asc(statuses.position));
      for (const s of own) {
        const to = mapping[s.id] && target.some((t) => t.id === mapping[s.id]) ? mapping[s.id]
          : (target.find((t) => t.name.toLowerCase() === s.name.toLowerCase()) ?? target.find((t) => t.group === s.group) ?? target[0]).id;
        await tx.update(tasks).set({ statusId: to }).where(and(eq(tasks.listId, l.id), eq(tasks.statusId, s.id)));
      }
      await tx.update(lists).set({ statusSetId: null }).where(eq(lists.id, l.id));
      await tx.delete(statusSets).where(eq(statusSets.id, l.statusSetId));
    });
    return { ok: true };
  });

  // ── sharing (share dialog) ──
  const shareParams = z.object({ type: z.enum(['space', 'folder', 'list', 'task', 'doc']), id: z.string().uuid() });

  app.get('/sharing/:type/:id', async (req) => {
    const { access } = auth(req);
    const { type, id } = parse(shareParams, req.params);
    const level = await access.require('view', type, id);
    const sharing = await getSharing(db, type, id);
    const principalIds = sharing.chain.flatMap((c) => c.entries.map((e) => e.principalId));
    const [us, gs] = principalIds.length ? await Promise.all([
      db.select({ id: users.id, displayName: users.displayName, email: users.email, role: users.role }).from(users).where(inArray(users.id, principalIds)),
      db.select({ id: groups.id, name: groups.name }).from(groups).where(inArray(groups.id, principalIds)),
    ]) : [[], []];
    return { ...sharing, users: us, groups: gs, canEdit: level === 'full' && !access.isGuest };
  });

  app.put('/sharing/:type/:id', async (req) => {
    const { user, access } = auth(req);
    const { type, id } = parse(shareParams, req.params);
    if (access.isGuest) throw new Forbidden('Guests cannot change sharing');
    await access.require('share', type, id);
    const input = parse(saveSharingSchema, req.body);
    await runTx((tx) => setSharing(tx, type as SecurableType, id, input.mode, input.entries, user.id));
    // guard against locking yourself out of something you just made private
    return { ok: true, yourLevel: (await access.levelOf(type, id)) as Level };
  });
}

/**
 * Save a status set. `copyForListId` = creating a list override: every input status becomes new,
 * and tasks in that list move from the inherited status (input id) to its copy.
 */
async function saveStatuses(tx: Tx, setId: string, input: z.infer<typeof saveStatusSetSchema>, copyForListId: string | null) {
  if (!input.statuses.some((s) => s.group === 'open')) throw new Validation('At least one status must be in the "open" group');
  const existing = await tx.select().from(statuses).where(eq(statuses.statusSetId, setId));
  const idMap = new Map<string, string>(); // input/source id → saved id
  for (const [i, s] of input.statuses.entries()) {
    const keep = !copyForListId && s.id && existing.some((e) => e.id === s.id);
    if (keep) {
      await tx.update(statuses).set({ name: s.name, color: s.color, group: s.group, position: i }).where(eq(statuses.id, s.id!));
      idMap.set(s.id!, s.id!);
    } else {
      const [n] = await tx.insert(statuses).values({ statusSetId: setId, name: s.name, color: s.color, group: s.group, position: i }).returning();
      if (s.id) idMap.set(s.id, n.id);
    }
  }
  const saved = await tx.select().from(statuses).where(eq(statuses.statusSetId, setId)).orderBy(asc(statuses.position));
  const resolve = (oldId: string, oldName?: string, oldGroup?: string) => {
    const mapped = input.mapping[oldId];
    if (mapped && idMap.has(mapped)) return idMap.get(mapped)!;
    if (idMap.has(oldId)) return idMap.get(oldId)!;
    return (saved.find((s) => s.name.toLowerCase() === oldName?.toLowerCase()) ?? saved.find((s) => s.group === oldGroup) ?? saved[0]).id;
  };

  if (copyForListId) {
    const inherited = await statusesForList(tx, copyForListId).catch(() => []);
    const sourceIds = new Set([...inherited.map((s) => s.id), ...idMap.keys()]);
    const used = await tx.selectDistinct({ statusId: tasks.statusId }).from(tasks).where(eq(tasks.listId, copyForListId));
    for (const { statusId } of used) {
      if (saved.some((s) => s.id === statusId)) continue;
      const [old] = await tx.select().from(statuses).where(eq(statuses.id, statusId));
      if (!sourceIds.has(statusId) && !old) continue;
      await tx.update(tasks).set({ statusId: resolve(statusId, old?.name, old?.group) }).where(and(eq(tasks.listId, copyForListId), eq(tasks.statusId, statusId)));
    }
  } else {
    const removed = existing.filter((e) => !idMap.has(e.id));
    for (const r of removed) await tx.update(tasks).set({ statusId: resolve(r.id, r.name, r.group) }).where(eq(tasks.statusId, r.id));
    if (removed.length) await tx.delete(statuses).where(inArray(statuses.id, removed.map((r) => r.id)));
  }
  // keep completed_at consistent with the (possibly regrouped) statuses
  await tx.execute(sql`update tasks t set completed_at = case when s."group" in ('done','closed') then coalesce(t.completed_at, now()) else null end
    from statuses s where s.id = t.status_id and s.status_set_id = ${setId}`);
}

export { statusSetIdForList };
