import { asc, eq, inArray } from 'drizzle-orm';
import type { Tx } from '../../db/client';
import { folders, lists, spaces, statuses, statusSets } from '../../db/schema';
import { NotFound } from '../../lib/errors';

export const DEFAULT_STATUSES = [
  { name: 'To do', color: '#94a3b8', group: 'open' as const },
  { name: 'In progress', color: '#3b82f6', group: 'active' as const },
  { name: 'In review', color: '#a855f7', group: 'active' as const },
  { name: 'Done', color: '#22c55e', group: 'done' as const },
  { name: 'Closed', color: '#475569', group: 'closed' as const },
];

export async function createStatusSet(
  tx: Tx,
  ownerType: 'space' | 'list',
  ownerId: string,
  defs: Array<{ name: string; color: string; group: 'open' | 'active' | 'done' | 'closed' }> = DEFAULT_STATUSES,
) {
  const [set] = await tx.insert(statusSets).values({ ownerType, ownerId }).returning();
  await tx.insert(statuses).values(defs.map((d, i) => ({ ...d, statusSetId: set.id, position: i })));
  return set.id;
}

/** The status set that applies to a list (its override, else its space's). */
export async function statusSetIdForList(tx: Tx, listId: string): Promise<string> {
  const [row] = await tx
    .select({ own: lists.statusSetId, space: spaces.statusSetId })
    .from(lists).innerJoin(spaces, eq(spaces.id, lists.spaceId))
    .where(eq(lists.id, listId));
  if (!row) throw new NotFound('List not found');
  return (row.own ?? row.space)!;
}

export async function statusesForList(tx: Tx, listId: string) {
  const setId = await statusSetIdForList(tx, listId);
  return tx.select().from(statuses).where(eq(statuses.statusSetId, setId)).orderBy(asc(statuses.position));
}

export async function statusesForSets(tx: Tx, setIds: string[]) {
  if (!setIds.length) return [];
  return tx.select().from(statuses).where(inArray(statuses.statusSetId, setIds)).orderBy(asc(statuses.position));
}

/** Breadcrumb names for a list (space › folder › list). Names only — safe for "traverse" nav. */
export async function listPath(tx: Tx, listId: string) {
  const [row] = await tx
    .select({ list: lists, space: spaces, folder: folders })
    .from(lists)
    .innerJoin(spaces, eq(spaces.id, lists.spaceId))
    .leftJoin(folders, eq(folders.id, lists.folderId))
    .where(eq(lists.id, listId));
  if (!row) return null;
  return {
    space: { id: row.space.id, name: row.space.name, color: row.space.color, keyPrefix: row.space.keyPrefix },
    folder: row.folder ? { id: row.folder.id, name: row.folder.name } : null,
    list: { id: row.list.id, name: row.list.name },
  };
}
