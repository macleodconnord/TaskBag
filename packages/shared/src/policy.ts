import type { Level, ScopeMode, WorkspaceRole } from './enums';

const RANK: Record<Level, number> = { none: 0, view: 1, comment: 2, edit: 3, full: 4 };

export const levelRank = (l: Level) => RANK[l];
export const maxLevel = (a: Level, b: Level): Level => (RANK[a] >= RANK[b] ? a : b);
export const minLevel = (a: Level, b: Level): Level => (RANK[a] <= RANK[b] ? a : b);
export const atLeast = (have: Level, need: Level) => RANK[have] >= RANK[need];

/** Every action the API checks, mapped to the minimum level on the target object. */
export const ACTION_LEVELS = {
  view: 'view',
  comment: 'comment',
  edit: 'edit',
  create_child: 'edit',
  attach: 'edit',
  delete: 'full',
  share: 'full',
  manage: 'full', // statuses, fields, views, settings at this scope
} as const satisfies Record<string, Level>;
export type Action = keyof typeof ACTION_LEVELS;

export const requiredLevel = (action: Action): Level => ACTION_LEVELS[action];
export const can = (level: Level, action: Action) => atLeast(level, requiredLevel(action));

export interface ScopeNode {
  id: string;
  parentScopeId: string | null;
  mode: ScopeMode;
}
export interface Entry {
  scopeId: string;
  principalType: 'user' | 'group';
  principalId: string;
  level: Level;
}
export interface Principal {
  userId: string;
  role: WorkspaceRole;
  groupIds: string[];
}

export const isAdminRole = (role: WorkspaceRole) => role === 'owner' || role === 'admin';

/**
 * Reference resolution from permissions.md §2.1: walk up additive scopes, stop at an override.
 * Owners/admins get full everywhere; guests are capped at edit.
 */
export function effectiveLevel(
  p: Principal,
  scopeId: string | null,
  scopes: Map<string, ScopeNode>,
  entriesByScope: Map<string, Entry[]>,
): Level {
  if (isAdminRole(p.role)) return 'full';
  const groups = new Set(p.groupIds);
  let level: Level = 'none';
  let scope = scopeId ? scopes.get(scopeId) : undefined;
  const seen = new Set<string>();
  while (scope && !seen.has(scope.id)) {
    seen.add(scope.id);
    for (const e of entriesByScope.get(scope.id) ?? []) {
      const applies =
        (e.principalType === 'user' && e.principalId === p.userId) ||
        (e.principalType === 'group' && groups.has(e.principalId));
      if (applies) level = maxLevel(level, e.level);
    }
    if (scope.mode === 'override' || !scope.parentScopeId) break;
    scope = scopes.get(scope.parentScopeId);
  }
  if (p.role === 'guest') level = minLevel(level, 'edit');
  return level;
}

/** Levels for every scope at once (one pass per scope; scope counts are small). */
export function levelsForAllScopes(
  p: Principal,
  scopes: Map<string, ScopeNode>,
  entriesByScope: Map<string, Entry[]>,
): Map<string, Level> {
  const out = new Map<string, Level>();
  for (const id of scopes.keys()) out.set(id, effectiveLevel(p, id, scopes, entriesByScope));
  return out;
}
