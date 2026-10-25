import { eq } from 'drizzle-orm';
import { db, type Tx } from '../../../db/client';
import { folders, lists, spaces, statuses, workspaces } from '../../../db/schema';
import { rootScopeId } from '../../../lib/acl';
import { runTx } from '../../../lib/tx';
import { createStatusSet } from '../../hierarchy/service';
import type { CuFolder, CuList, CuSpace, CuStatus } from '../clickup/schemas';
import { checksum, type ImportContext } from '../context';
import { markdownToRichText } from '../markdown';

export interface PlanFolder { cu: CuFolder; spaceExt: string }
export interface PlanList {
  cu: CuList;
  spaceExt: string;
  folderExt: string | null;
  /** effective ClickUp statuses (list override → folder override → space) */
  statuses: CuStatus[];
  /** statuses differ from the space's: needs its own status set */
  ownStatuses: boolean;
  archived: boolean;
}
export interface HierarchyPlan {
  spaces: CuSpace[];
  folders: PlanFolder[];
  lists: PlanList[];
}

/** ClickUp status type → our status group. */
export const groupFor = (type: string | null | undefined) =>
  (type === 'open' ? 'open' : type === 'done' ? 'done' : type === 'closed' ? 'closed' : 'active') as 'open' | 'active' | 'done' | 'closed';

const sortStatuses = (s: CuStatus[]) => [...s].sort((a, b) => a.orderindex - b.orderindex);
const statusSig = (s: CuStatus[]) => sortStatuses(s).map((x) => `${x.status.toLowerCase()}|${groupFor(x.type)}`).join(',');
const color = (c: string | null | undefined, fallback = '#94a3b8') => (c && /^#[0-9a-f]{3,8}$/i.test(c) ? c : fallback);

/** Read the whole ClickUp hierarchy (incl. archived folders/lists when enabled). API only, no writes. */
export async function fetchHierarchy(ctx: ImportContext): Promise<HierarchyPlan> {
  const { api } = ctx;
  const arch = ctx.options.includeArchived;
  const spaceList = [...(await api.getSpaces(false)), ...(arch ? (await api.getSpaces(true)).map((s) => ({ ...s, archived: true })) : [])];
  const plan: HierarchyPlan = { spaces: [], folders: [], lists: [] };
  const seenSpaces = new Set<string>();
  for (const s of spaceList) {
    if (seenSpaces.has(s.id)) continue;
    seenSpaces.add(s.id);
    plan.spaces.push(s);
    const spaceSig = statusSig(s.statuses);
    const addList = async (l: CuList, folder: CuFolder | null, archived: boolean) => {
      let own: CuStatus[] | null = null;
      if (l.override_statuses) {
        own = l.statuses?.length ? l.statuses : (await api.getList(l.id)).statuses ?? null;
      } else if (folder?.override_statuses && folder.statuses?.length) {
        own = folder.statuses;
      }
      const eff = own?.length ? own : s.statuses;
      plan.lists.push({
        cu: l, spaceExt: s.id, folderExt: folder && !folder.hidden ? folder.id : null,
        statuses: sortStatuses(eff), ownStatuses: !!own?.length && statusSig(own) !== spaceSig,
        archived: archived || l.archived || !!folder?.archived || !!s.archived,
      });
    };
    const fs = [...(await api.getFolders(s.id, false)), ...(arch ? (await api.getFolders(s.id, true)).map((f) => ({ ...f, archived: true })) : [])];
    const seenLists = new Set<string>();
    for (const f of fs) {
      if (!f.hidden) plan.folders.push({ cu: f, spaceExt: s.id });
      const fl = [...f.lists, ...(arch && !f.archived ? (await api.getFolderLists(f.id, true)).map((l) => ({ ...l, archived: true })) : [])];
      for (const l of fl) {
        if (seenLists.has(l.id)) continue;
        seenLists.add(l.id);
        await addList(l, f, f.archived || l.archived);
      }
    }
    const loose = [...(await api.getFolderlessLists(s.id, false)), ...(arch ? (await api.getFolderlessLists(s.id, true)).map((l) => ({ ...l, archived: true })) : [])];
    for (const l of loose) {
      if (seenLists.has(l.id)) continue;
      seenLists.add(l.id);
      await addList(l, null, l.archived);
    }
  }
  return plan;
}

function keyPrefixFor(name: string, taken: Set<string>) {
  const words = name.toUpperCase().replace(/[^A-Z0-9]+/g, ' ').trim().split(' ').filter(Boolean);
  let base = words.length > 1 ? words.map((w) => w[0]).join('').slice(0, 4) : (words[0] ?? 'SP').slice(0, 4);
  if (!/^[A-Z]/.test(base)) base = `S${base}`.slice(0, 4);
  if (base.length < 2) base = `${base}X`;
  let k = base;
  for (let n = 2; taken.has(k); n++) k = `${base}${n}`.slice(0, 10);
  taken.add(k);
  return k;
}

/** Bring a status set in line with ClickUp statuses (adds/updates; never deletes statuses tasks may use). */
async function syncStatuses(ctx: ImportContext, tx: Tx, setId: string | null, ownerKey: string, cu: CuStatus[]) {
  const existing = setId ? await tx.select().from(statuses).where(eq(statuses.statusSetId, setId)) : [];
  for (const [i, s] of sortStatuses(cu).entries()) {
    const ext = `${ownerKey}:${s.status.toLowerCase()}`;
    ctx.stat('status', 'seen');
    const want = { name: s.status.slice(0, 50), color: color(s.color), group: groupFor(s.type), position: i };
    const sum = checksum(want);
    const mapped = await ctx.lookup('status', ext);
    const row = mapped && existing.find((e) => e.id === mapped.id);
    if (ctx.dry || !setId) {
      ctx.stat('status', !mapped ? 'created' : mapped.checksum === sum ? 'unchanged' : 'updated');
      continue;
    }
    if (row) {
      if (mapped!.checksum !== sum) {
        await tx.update(statuses).set(want).where(eq(statuses.id, row.id));
        await ctx.link(tx, 'status', ext, row.id, sum);
        ctx.stat('status', 'updated');
      } else ctx.stat('status', 'unchanged');
      continue;
    }
    // a status with the same name already in the set (e.g. created by the set defaults) is reused
    const same = existing.find((e) => e.name.toLowerCase() === want.name.toLowerCase());
    if (same) {
      await tx.update(statuses).set(want).where(eq(statuses.id, same.id));
      await ctx.link(tx, 'status', ext, same.id, sum);
      ctx.stat('status', 'updated');
    } else {
      const [n] = await tx.insert(statuses).values({ ...want, statusSetId: setId }).returning({ id: statuses.id });
      await ctx.link(tx, 'status', ext, n.id, sum);
      ctx.stat('status', 'created');
    }
  }
}

async function newStatusSet(tx: Tx, ownerType: 'space' | 'list', ownerId: string, cu: CuStatus[]) {
  // create with ClickUp's statuses directly (avoids default statuses ClickUp doesn't have)
  const defs = sortStatuses(cu).map((s) => ({ name: s.status.slice(0, 50), color: color(s.color), group: groupFor(s.type) }));
  return createStatusSet(tx, ownerType, ownerId, defs.length ? defs : undefined);
}

/** Stage 2: spaces (unique key prefix), folders, lists and status sets, idempotent via external_ids. */
export async function runHierarchy(ctx: ImportContext) {
  const plan = ctx.plan!;
  const total = plan.spaces.length + plan.folders.length + plan.lists.length;
  let done = 0;
  const taken = new Set((await db.select({ k: spaces.keyPrefix }).from(spaces)).map((r) => r.k));
  const [ws] = await db.select().from(workspaces).limit(1);
  ctx.workspaceId = ws.id;

  for (const [i, s] of plan.spaces.entries()) {
    ctx.stat('space', 'seen');
    const want = { name: s.name.slice(0, 100), color: color(s.color, '#6366f1'), archived: !!s.archived };
    const sum = checksum({ ...want, statuses: statusSig(s.statuses) });
    const mapped = await ctx.lookup('space', s.id);
    if (ctx.dry) {
      ctx.stat('space', !mapped ? 'created' : mapped.checksum === sum ? 'unchanged' : 'updated');
      if (!mapped) keyPrefixFor(s.name, taken);
      await syncStatuses(ctx, db, null, `space:${s.id}`, s.statuses);
    } else {
      await runTx(async (tx) => {
        let row = mapped ? (await tx.select().from(spaces).where(eq(spaces.id, mapped.id)))[0] : undefined;
        if (!row) {
          [row] = await tx.insert(spaces).values({
            workspaceId: ws.id, name: want.name, keyPrefix: keyPrefixFor(s.name, taken), color: want.color, position: 1000 + i,
            aclScopeId: await rootScopeId(tx), archivedAt: want.archived ? new Date() : null,
          }).returning();
          const setId = await newStatusSet(tx, 'space', row.id, s.statuses);
          await tx.update(spaces).set({ statusSetId: setId }).where(eq(spaces.id, row.id));
          row.statusSetId = setId;
          ctx.stat('space', 'created');
        } else if (mapped!.checksum !== sum) {
          await tx.update(spaces).set({ name: want.name, color: want.color, archivedAt: want.archived ? (row.archivedAt ?? new Date()) : null }).where(eq(spaces.id, row.id));
          ctx.stat('space', 'updated');
        } else ctx.stat('space', 'unchanged');
        await syncStatuses(ctx, tx, row.statusSetId, `space:${s.id}`, s.statuses);
        await ctx.link(tx, 'space', s.id, row.id, sum);
      });
    }
    ctx.progress(++done, total, s.name);
    await ctx.checkpoint();
  }

  for (const f of plan.folders) {
    ctx.stat('folder', 'seen');
    const want = { name: f.cu.name.slice(0, 100), position: f.cu.orderindex, archived: !!f.cu.archived };
    const sum = checksum(want);
    const mapped = await ctx.lookup('folder', f.cu.id);
    if (ctx.dry) {
      ctx.stat('folder', !mapped ? 'created' : mapped.checksum === sum ? 'unchanged' : 'updated');
    } else {
      await runTx(async (tx) => {
        const spaceId = (await ctx.idOf('space', f.spaceExt))!;
        let row = mapped ? (await tx.select().from(folders).where(eq(folders.id, mapped.id)))[0] : undefined;
        if (!row) {
          const [sp] = await tx.select().from(spaces).where(eq(spaces.id, spaceId));
          [row] = await tx.insert(folders).values({
            spaceId, name: want.name, position: want.position, aclScopeId: sp.aclScopeId, archivedAt: want.archived ? new Date() : null,
          }).returning();
          ctx.stat('folder', 'created');
        } else if (mapped!.checksum !== sum) {
          await tx.update(folders).set({ name: want.name, position: want.position, archivedAt: want.archived ? (row.archivedAt ?? new Date()) : null }).where(eq(folders.id, row.id));
          ctx.stat('folder', 'updated');
        } else ctx.stat('folder', 'unchanged');
        await ctx.link(tx, 'folder', f.cu.id, row.id, sum);
      });
    }
    ctx.progress(++done, total, f.cu.name);
    await ctx.checkpoint();
  }

  for (const l of plan.lists) {
    ctx.stat('list', 'seen');
    const want = { name: l.cu.name.slice(0, 100), position: l.cu.orderindex, archived: l.archived, content: l.cu.content ?? '', folder: l.folderExt };
    const sum = checksum({ ...want, statuses: l.ownStatuses ? statusSig(l.statuses) : null });
    const mapped = await ctx.lookup('list', l.cu.id);
    if (ctx.dry) {
      ctx.stat('list', !mapped ? 'created' : mapped.checksum === sum ? 'unchanged' : 'updated');
      if (l.ownStatuses) await syncStatuses(ctx, db, null, `list:${l.cu.id}`, l.statuses);
    } else {
      await runTx(async (tx) => {
        const spaceId = (await ctx.idOf('space', l.spaceExt))!;
        const folderId = l.folderExt ? await ctx.idOf('folder', l.folderExt) : null;
        let row = mapped ? (await tx.select().from(lists).where(eq(lists.id, mapped.id)))[0] : undefined;
        const description = markdownToRichText(l.cu.content);
        if (!row) {
          const [parent] = folderId
            ? await tx.select({ s: folders.aclScopeId }).from(folders).where(eq(folders.id, folderId))
            : await tx.select({ s: spaces.aclScopeId }).from(spaces).where(eq(spaces.id, spaceId));
          [row] = await tx.insert(lists).values({
            spaceId, folderId, name: want.name, description, position: want.position, aclScopeId: parent.s,
            archivedAt: want.archived ? new Date() : null,
          }).returning();
          ctx.stat('list', 'created');
        } else if (mapped!.checksum !== sum) {
          if (row.folderId !== folderId || row.spaceId !== spaceId) {
            ctx.issue('warn', 'list', l.cu.id, `List "${l.cu.name}" moved in ClickUp; move it here manually (the importer does not move lists)`);
          }
          await tx.update(lists).set({ name: want.name, description, position: want.position, archivedAt: want.archived ? (row.archivedAt ?? new Date()) : null }).where(eq(lists.id, row.id));
          ctx.stat('list', 'updated');
        } else ctx.stat('list', 'unchanged');
        if (l.ownStatuses) {
          let setId = row.statusSetId;
          if (!setId) {
            setId = await newStatusSet(tx, 'list', row.id, l.statuses);
            await tx.update(lists).set({ statusSetId: setId }).where(eq(lists.id, row.id));
          }
          await syncStatuses(ctx, tx, setId, `list:${l.cu.id}`, l.statuses);
        }
        await ctx.link(tx, 'list', l.cu.id, row.id, sum);
      });
    }
    ctx.progress(++done, total, l.cu.name);
    await ctx.checkpoint();
  }
}

/** Status lookup for a list by ClickUp status name (falls back to the same group). Non-dry only. */
export async function statusIdFor(tx: Tx, listId: string, setCache: Map<string, Array<typeof statuses.$inferSelect>>, name: string, type: string | null | undefined) {
  let sts = setCache.get(listId);
  if (!sts) {
    const [row] = await tx.select({ own: lists.statusSetId, space: spaces.statusSetId }).from(lists)
      .innerJoin(spaces, eq(spaces.id, lists.spaceId)).where(eq(lists.id, listId));
    sts = await tx.select().from(statuses).where(eq(statuses.statusSetId, (row.own ?? row.space)!));
    setCache.set(listId, sts);
  }
  const byName = sts.find((s) => s.name.toLowerCase() === name.toLowerCase());
  if (byName) return { id: byName.id, group: byName.group, exact: true };
  const g = groupFor(type);
  const byGroup = sts.find((s) => s.group === g) ?? sts[0];
  return { id: byGroup.id, group: byGroup.group, exact: false };
}

