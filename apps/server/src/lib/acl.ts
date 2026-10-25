import { and, eq, inArray, or, sql } from 'drizzle-orm';
import type { Tx } from '../db/client';
import { aclEntries, aclScopes, docs, folders, groups, lists, spaces, tasks, users } from '../db/schema';
import { bumpAcl, scopeIdOf, type SecurableType } from './access';
import { NotFound, Validation } from './errors';
import { afterCommit } from './tx';

/** Workspace root scope (override, All Members → edit). Created by the seed. */
export async function rootScopeId(tx: Tx): Promise<string> {
  const [row] = await tx.select({ id: aclScopes.id }).from(aclScopes).where(eq(aclScopes.objectType, 'workspace')).limit(1);
  if (!row) throw new Error('Workspace root scope missing: run the seed');
  return row.id;
}

export interface Subtree {
  spaces: string[];
  folders: string[];
  lists: string[];
  tasks: string[];
  docs: string[];
}

/** The object itself plus everything that can inherit its scope. */
export async function subtree(tx: Tx, type: SecurableType, id: string): Promise<Subtree> {
  const out: Subtree = { spaces: [], folders: [], lists: [], tasks: [], docs: [] };
  if (type === 'space') {
    out.spaces = [id];
    out.folders = (await tx.select({ id: folders.id }).from(folders).where(eq(folders.spaceId, id))).map((r) => r.id);
    out.lists = (await tx.select({ id: lists.id }).from(lists).where(eq(lists.spaceId, id))).map((r) => r.id);
  } else if (type === 'folder') {
    out.folders = [id];
    out.lists = (await tx.select({ id: lists.id }).from(lists).where(eq(lists.folderId, id))).map((r) => r.id);
  } else if (type === 'list') {
    out.lists = [id];
  }

  if (type === 'task') {
    const rows = await tx.execute<{ id: string }>(sql`
      with recursive t as (
        select id from tasks where id = ${id}
        union all
        select c.id from tasks c join t on c.parent_task_id = t.id
      ) select id from t`);
    out.tasks = rows.map((r) => r.id);
  } else if (out.lists.length) {
    out.tasks = (await tx.select({ id: tasks.id }).from(tasks).where(inArray(tasks.listId, out.lists))).map((r) => r.id);
  }

  if (type === 'doc') {
    const rows = await tx.execute<{ id: string }>(sql`
      with recursive d as (
        select id from docs where id = ${id}
        union all
        select c.id from docs c join d on c.parent_doc_id = d.id
      ) select id from d`);
    out.docs = rows.map((r) => r.id);
  } else if (type !== 'task') {
    const conds = [];
    if (out.spaces.length) conds.push(and(eq(docs.containerType, 'space'), inArray(docs.containerId, out.spaces)));
    if (out.folders.length) conds.push(and(eq(docs.containerType, 'folder'), inArray(docs.containerId, out.folders)));
    if (out.lists.length) conds.push(and(eq(docs.containerType, 'list'), inArray(docs.containerId, out.lists)));
    if (conds.length) out.docs = (await tx.select({ id: docs.id }).from(docs).where(or(...conds))).map((r) => r.id);
  }
  return out;
}

/**
 * Within `sub`, replace `oldScope` by `newScope` both as objects' acl_scope_id and as
 * own scopes' parent_scope_id. This is the single primitive behind sharing changes and moves.
 */
export async function repoint(tx: Tx, sub: Subtree, oldScope: string, newScope: string) {
  if (oldScope === newScope) return;
  const tables = [
    [spaces, sub.spaces], [folders, sub.folders], [lists, sub.lists], [tasks, sub.tasks], [docs, sub.docs],
  ] as const;
  for (const [t, ids] of tables) {
    if (!ids.length) continue;
    await tx.update(t).set({ aclScopeId: newScope }).where(and(inArray(t.id, ids), eq(t.aclScopeId, oldScope)));
  }
  const allIds = [...sub.spaces, ...sub.folders, ...sub.lists, ...sub.tasks, ...sub.docs];
  if (allIds.length) {
    await tx.update(aclScopes).set({ parentScopeId: newScope })
      .where(and(eq(aclScopes.parentScopeId, oldScope), inArray(aclScopes.objectId, allIds)));
  }
  afterCommit(bumpAcl);
}

/** The scope an object would inherit if it had none of its own. */
export async function parentScopeOf(tx: Tx, type: SecurableType, id: string): Promise<string> {
  if (type === 'space') return rootScopeId(tx);
  if (type === 'folder') {
    const [f] = await tx.select({ spaceId: folders.spaceId }).from(folders).where(eq(folders.id, id));
    if (!f) throw new NotFound();
    return (await scopeIdOf('space', f.spaceId, tx))!;
  }
  if (type === 'list') {
    const [l] = await tx.select({ spaceId: lists.spaceId, folderId: lists.folderId }).from(lists).where(eq(lists.id, id));
    if (!l) throw new NotFound();
    return l.folderId ? (await scopeIdOf('folder', l.folderId, tx))! : (await scopeIdOf('space', l.spaceId, tx))!;
  }
  if (type === 'task') {
    const [t] = await tx.select({ listId: tasks.listId, parentTaskId: tasks.parentTaskId }).from(tasks).where(eq(tasks.id, id));
    if (!t) throw new NotFound();
    return t.parentTaskId ? (await scopeIdOf('task', t.parentTaskId, tx))! : (await scopeIdOf('list', t.listId, tx))!;
  }
  const [d] = await tx.select().from(docs).where(eq(docs.id, id));
  if (!d) throw new NotFound();
  if (d.parentDocId) return (await scopeIdOf('doc', d.parentDocId, tx))!;
  return (await scopeIdOf(d.containerType, d.containerId, tx))!;
}

async function ownScope(tx: Tx, type: SecurableType, id: string) {
  const [s] = await tx.select().from(aclScopes).where(and(eq(aclScopes.objectType, type), eq(aclScopes.objectId, id)));
  return s ?? null;
}

export interface ShareEntryInput {
  principalType: 'user' | 'group';
  principalId: string;
  level: 'view' | 'comment' | 'edit' | 'full';
}

/** Current sharing state for the share dialog. */
export async function getSharing(tx: Tx, type: SecurableType, id: string) {
  const own = await ownScope(tx, type, id);
  const effectiveScopeId = own?.id ?? (await scopeIdOf(type, id, tx));
  // entries of the scope chain that actually applies, for display ("inherited from ...")
  const chain: Array<{ scopeId: string; objectType: string; objectId: string; mode: string; entries: ShareEntryInput[] }> = [];
  let cur = effectiveScopeId;
  const seen = new Set<string>();
  while (cur && !seen.has(cur)) {
    seen.add(cur);
    const [s] = await tx.select().from(aclScopes).where(eq(aclScopes.id, cur));
    if (!s) break;
    const entries = await tx.select().from(aclEntries).where(eq(aclEntries.scopeId, s.id));
    chain.push({
      scopeId: s.id, objectType: s.objectType, objectId: s.objectId, mode: s.mode,
      entries: entries.map((e) => ({ principalType: e.principalType, principalId: e.principalId, level: e.level })),
    });
    if (s.mode === 'override') break;
    cur = s.parentScopeId!;
  }
  return { mode: (own?.mode ?? 'inherit') as 'inherit' | 'additive' | 'override', chain };
}

/**
 * Apply the share dialog: inherit (drop own scope), additive (parent + entries) or
 * override (only entries). Handles creating/removing the scope and repointing descendants.
 */
export async function setSharing(tx: Tx, type: SecurableType, id: string, mode: 'inherit' | 'additive' | 'override', entries: ShareEntryInput[], actorId: string) {
  await validatePrincipals(tx, entries);
  const own = await ownScope(tx, type, id);
  const parentScope = await parentScopeOf(tx, type, id);

  if (mode === 'inherit') {
    if (own) {
      await repoint(tx, await subtree(tx, type, id), own.id, parentScope);
      await tx.delete(aclScopes).where(eq(aclScopes.id, own.id));
    }
    afterCommit(bumpAcl);
    return;
  }

  let scopeId: string;
  if (!own) {
    const [s] = await tx.insert(aclScopes).values({ objectType: type, objectId: id, parentScopeId: parentScope, mode }).returning();
    scopeId = s.id;
    const current = (await scopeIdOf(type, id, tx))!;
    await repoint(tx, await subtree(tx, type, id), current, scopeId);
    // repoint() sets parent_scope_id for scopes under the object; our own scope keeps its parent.
    await tx.update(aclScopes).set({ parentScopeId: parentScope }).where(eq(aclScopes.id, scopeId));
  } else {
    scopeId = own.id;
    if (own.mode !== mode) await tx.update(aclScopes).set({ mode }).where(eq(aclScopes.id, scopeId));
  }

  await tx.delete(aclEntries).where(eq(aclEntries.scopeId, scopeId));
  const dedup = new Map(entries.map((e) => [`${e.principalType}:${e.principalId}`, e]));
  if (dedup.size) {
    await tx.insert(aclEntries).values([...dedup.values()].map((e) => ({ scopeId, ...e, grantedBy: actorId })));
  }
  afterCommit(bumpAcl);
}

/** "Make private" on create: override scope with the creator as full. */
export async function makePrivate(tx: Tx, type: SecurableType, id: string, creatorId: string) {
  await setSharing(tx, type, id, 'override', [{ principalType: 'user', principalId: creatorId, level: 'full' }], creatorId);
}

/**
 * After an object moved under a new parent: if it inherits, repoint its subtree to the new
 * parent's scope; if it has an own scope, re-parent that scope.
 */
export async function afterMove(tx: Tx, type: SecurableType, id: string, oldInheritedScope: string) {
  const newParent = await parentScopeOf(tx, type, id);
  const own = await ownScope(tx, type, id);
  if (own) {
    await tx.update(aclScopes).set({ parentScopeId: newParent }).where(eq(aclScopes.id, own.id));
    afterCommit(bumpAcl);
  } else {
    await repoint(tx, await subtree(tx, type, id), oldInheritedScope, newParent);
  }
}

/** Remove scopes owned by objects that are being hard-deleted. */
export async function dropScopesFor(tx: Tx, objectIds: string[]) {
  if (!objectIds.length) return;
  await tx.delete(aclScopes).where(inArray(aclScopes.objectId, objectIds));
  afterCommit(bumpAcl);
}

async function validatePrincipals(tx: Tx, entries: ShareEntryInput[]) {
  const userIds = entries.filter((e) => e.principalType === 'user').map((e) => e.principalId);
  const groupIds = entries.filter((e) => e.principalType === 'group').map((e) => e.principalId);
  if (userIds.length) {
    const found = await tx.select({ id: users.id }).from(users).where(inArray(users.id, userIds));
    if (found.length !== new Set(userIds).size) throw new Validation('Unknown user in sharing entries');
  }
  if (groupIds.length) {
    const found = await tx.select({ id: groups.id }).from(groups).where(inArray(groups.id, groupIds));
    if (found.length !== new Set(groupIds).size) throw new Validation('Unknown group in sharing entries');
  }
}
