import {
  atLeast, can, effectiveLevel, isAdminRole, type Action, type Entry, type Level, type ScopeNode, type WorkspaceRole,
} from '@app/shared';
import { and, eq, inArray, isNull, sql, type AnyColumn, type SQL } from 'drizzle-orm';
import { db, type Tx } from '../db/client';
import { aclEntries, aclScopes, docs, folders, groupMembers, groups, lists, spaces, tasks, users } from '../db/schema';
import { Forbidden, NotFound } from './errors';

/**
 * Access control (permissions.md, simplified for ~10 users).
 *
 * Instead of a materialized user_scope_access table, the whole ACL graph (scopes + entries,
 * a few hundred rows) is cached in memory and each user's level per scope is computed with
 * the shared reference `effectiveLevel()`. Any ACL, group or role change calls `bumpAcl()`.
 */
let aclVersion = 1;
let graph: { version: number; scopes: Map<string, ScopeNode>; entries: Map<string, Entry[]>; allMembersGroupId: string | null } | null = null;
const userCache = new Map<string, { version: number; groupIds: string[]; levels: Map<string, Level> }>();

export function bumpAcl() {
  aclVersion++;
  graph = null;
  userCache.clear();
}
export const currentAclVersion = () => aclVersion;

async function loadGraph() {
  if (graph && graph.version === aclVersion) return graph;
  const version = aclVersion;
  const [scopeRows, entryRows, allMembers] = await Promise.all([
    db.select().from(aclScopes),
    db.select().from(aclEntries),
    db.select({ id: groups.id }).from(groups).where(and(eq(groups.isSystem, true), eq(groups.name, 'All Members'))),
  ]);
  const scopes = new Map<string, ScopeNode>(scopeRows.map((s) => [s.id, { id: s.id, parentScopeId: s.parentScopeId, mode: s.mode }]));
  const entries = new Map<string, Entry[]>();
  for (const e of entryRows) {
    const list = entries.get(e.scopeId) ?? [];
    list.push({ scopeId: e.scopeId, principalType: e.principalType, principalId: e.principalId, level: e.level });
    entries.set(e.scopeId, list);
  }
  const g = { version, scopes, entries, allMembersGroupId: allMembers[0]?.id ?? null };
  if (version === aclVersion) graph = g;
  return g;
}

export interface AccessUser {
  id: string;
  role: WorkspaceRole;
  isActive: boolean;
}

export type SecurableType = 'space' | 'folder' | 'list' | 'task' | 'doc';

const TABLES = { space: spaces, folder: folders, list: lists, task: tasks, doc: docs } as const;

export class AccessContext {
  constructor(public user: AccessUser) {}

  get isAdmin() {
    return this.user.isActive && isAdminRole(this.user.role);
  }
  get isGuest() {
    return this.user.role === 'guest';
  }

  private async state() {
    const g = await loadGraph();
    const cached = userCache.get(this.user.id);
    if (cached && cached.version === g.version) return cached;
    const memberRows = await db.select({ groupId: groupMembers.groupId }).from(groupMembers).where(eq(groupMembers.userId, this.user.id));
    const groupIds = memberRows.map((r) => r.groupId);
    if (this.user.role !== 'guest' && g.allMembersGroupId) groupIds.push(g.allMembersGroupId);
    const levels = new Map<string, Level>();
    if (this.user.isActive) {
      const principal = { userId: this.user.id, role: this.user.role, groupIds };
      for (const id of g.scopes.keys()) levels.set(id, effectiveLevel(principal, id, g.scopes, g.entries));
    }
    const s = { version: g.version, groupIds, levels };
    userCache.set(this.user.id, s);
    return s;
  }

  async levelOfScope(scopeId: string): Promise<Level> {
    if (!this.user.isActive) return 'none';
    if (this.isAdmin) return 'full';
    return (await this.state()).levels.get(scopeId) ?? 'none';
  }

  /** Scope ids where the user has at least `min`; `null` means "everything" (admins). */
  async scopeIds(min: Level = 'view'): Promise<string[] | null> {
    if (this.isAdmin) return null;
    if (!this.user.isActive) return [];
    const { levels } = await this.state();
    return [...levels].filter(([, l]) => atLeast(l, min)).map(([id]) => id);
  }

  /** SQL condition restricting `column` (an acl_scope_id column) to scopes visible at `min`. */
  async filter(column: AnyColumn, min: Level = 'view'): Promise<SQL> {
    const ids = await this.scopeIds(min);
    if (ids === null) return sql`true`;
    if (ids.length === 0) return sql`false`;
    return inArray(column, ids);
  }

  async groupIds() {
    return (await this.state()).groupIds;
  }

  /** Level on a concrete object. Returns 'none' if it doesn't exist. */
  async levelOf(type: SecurableType, id: string, tx: Tx = db): Promise<Level> {
    const scopeId = await scopeIdOf(type, id, tx);
    if (!scopeId) return 'none';
    return this.levelOfScope(scopeId);
  }

  /**
   * Throw 404 if the object is invisible (so private objects don't leak), 403 if visible
   * but the level is too low. Returns the caller's level.
   */
  async require(action: Action, type: SecurableType, id: string, tx: Tx = db): Promise<Level> {
    const level = await this.levelOf(type, id, tx);
    if (level === 'none') throw new NotFound();
    if (!can(level, action)) throw new Forbidden();
    return level;
  }

  requireAdmin() {
    if (!this.isAdmin) throw new Forbidden('Admins only');
  }
}

export async function scopeIdOf(type: SecurableType, id: string, tx: Tx = db): Promise<string | null> {
  const t = TABLES[type];
  const where = type === 'task' ? and(eq(tasks.id, id), isNull(tasks.deletedAt)) : eq(t.id, id);
  const rows = await tx.select({ s: t.aclScopeId }).from(t).where(where).limit(1);
  return rows[0]?.s ?? null;
}

/** Access context for an arbitrary user (notification recipients, webhook acting users). */
export async function accessForUser(userId: string): Promise<AccessContext | null> {
  const [u] = await db.select({ id: users.id, role: users.role, isActive: users.isActive }).from(users).where(eq(users.id, userId));
  return u ? new AccessContext(u) : null;
}
