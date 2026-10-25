import { describe, expect, it } from 'vitest';
import { can, effectiveLevel, type Entry, type Principal, type ScopeNode } from './policy';
import { parseTaskRefs } from './keys';

/**
 * Permission matrix (permissions.md §8) at the unit level, against the reference resolver.
 * Fixture: root(override, All Members→edit) → S → F → L → T → ST.
 */
const ALL = 'g-all';
const GRP_A = 'g-a';
const users: Record<string, Principal> = {
  owner: { userId: 'owner', role: 'owner', groupIds: [ALL] },
  admin: { userId: 'admin', role: 'admin', groupIds: [ALL] },
  m1: { userId: 'm1', role: 'member', groupIds: [ALL] },
  m2: { userId: 'm2', role: 'member', groupIds: [ALL, GRP_A] },
  g1: { userId: 'g1', role: 'guest', groupIds: [] },
};

type Setup = { scopes: Record<string, { parent: string | null; mode: 'additive' | 'override' }>; entries: Array<[scope: string, type: 'user' | 'group', id: string, level: Entry['level']]> };

function world(extra: Partial<Setup> = {}) {
  const scopes: Setup['scopes'] = { root: { parent: null, mode: 'override' }, ...extra.scopes };
  const entries: Setup['entries'] = [['root', 'group', ALL, 'edit'], ...(extra.entries ?? [])];
  const scopeMap = new Map<string, ScopeNode>(Object.entries(scopes).map(([id, s]) => [id, { id, parentScopeId: s.parent, mode: s.mode }]));
  const entryMap = new Map<string, Entry[]>();
  for (const [scopeId, principalType, principalId, level] of entries) {
    entryMap.set(scopeId, [...(entryMap.get(scopeId) ?? []), { scopeId, principalType, principalId, level }]);
  }
  return (who: keyof typeof users, scope: string) => effectiveLevel(users[who], scope, scopeMap, entryMap);
}

describe('effectiveLevel — permission matrix', () => {
  it('1: default — members edit, guests nothing, admins full', () => {
    const lv = world();
    expect(lv('owner', 'root')).toBe('full');
    expect(lv('admin', 'root')).toBe('full');
    expect(lv('m1', 'root')).toBe('edit');
    expect(lv('g1', 'root')).toBe('none');
  });

  it('2: space override (m1 view) hides it from everyone else', () => {
    const lv = world({ scopes: { S: { parent: 'root', mode: 'override' } }, entries: [['S', 'user', 'm1', 'view']] });
    expect(lv('m1', 'S')).toBe('view');
    expect(lv('m2', 'S')).toBe('none');
    expect(lv('admin', 'S')).toBe('full');
  });

  it('3: private list (m1 full); m2 keeps edit on the space', () => {
    const lv = world({ scopes: { L: { parent: 'root', mode: 'override' } }, entries: [['L', 'user', 'm1', 'full']] });
    expect(lv('m1', 'L')).toBe('full');
    expect(lv('m2', 'L')).toBe('none');
    expect(lv('m2', 'root')).toBe('edit');
  });

  it('4/5: task shared with a guest (additive); guests are capped at edit', () => {
    const lv = world({ scopes: { T: { parent: 'root', mode: 'additive' } }, entries: [['T', 'user', 'g1', 'comment']] });
    expect(lv('g1', 'T')).toBe('comment');
    expect(lv('m1', 'T')).toBe('edit');
    const lv5 = world({ scopes: { T: { parent: 'root', mode: 'additive' } }, entries: [['T', 'user', 'g1', 'full']] });
    expect(lv5('g1', 'T')).toBe('edit');
  });

  it('6/7: private task and private subtask under an inherited task', () => {
    const lv = world({
      scopes: { ST: { parent: 'root', mode: 'override' } },
      entries: [['ST', 'user', 'm2', 'full']],
    });
    expect(lv('m1', 'root')).toBe('edit'); // T inherits root
    expect(lv('m1', 'ST')).toBe('none');
    expect(lv('m2', 'ST')).toBe('full');
  });

  it('8/9: group grant; removing the member removes access', () => {
    const lv = world({ scopes: { L: { parent: 'root', mode: 'override' } }, entries: [['L', 'group', GRP_A, 'comment']] });
    expect(lv('m2', 'L')).toBe('comment');
    expect(lv('m1', 'L')).toBe('none');
    const before = users.m2;
    users.m2 = { ...before, groupIds: [ALL] };
    try {
      expect(lv('m2', 'L')).toBe('none');
    } finally {
      users.m2 = before;
    }
  });

  it('11: folder override (m1 view) + list additive (m2 edit)', () => {
    const lv = world({
      scopes: { F: { parent: 'root', mode: 'override' }, L: { parent: 'F', mode: 'additive' } },
      entries: [['F', 'user', 'm1', 'view'], ['L', 'user', 'm2', 'edit']],
    });
    expect(lv('m1', 'L')).toBe('view');
    expect(lv('m2', 'L')).toBe('edit');
    expect(lv('g1', 'L')).toBe('none');
  });

  it('14/15: demoted to guest → only explicit grants; deactivation is handled by AccessContext', () => {
    const lv = world({ scopes: { T: { parent: 'root', mode: 'additive' } }, entries: [['T', 'user', 'm1', 'full']] });
    const before = users.m1;
    users.m1 = { userId: 'm1', role: 'guest', groupIds: [] };
    try {
      expect(lv('m1', 'root')).toBe('none');
      expect(lv('m1', 'T')).toBe('edit');
    } finally {
      users.m1 = before;
    }
  });

  it('terminates on a malformed cycle', () => {
    const lv = world({ scopes: { A: { parent: 'B', mode: 'additive' }, B: { parent: 'A', mode: 'additive' } } });
    expect(lv('m1', 'A')).toBe('none');
  });
});

describe('can()', () => {
  it('maps actions to levels', () => {
    expect(can('view', 'view')).toBe(true);
    expect(can('view', 'comment')).toBe(false);
    expect(can('comment', 'comment')).toBe(true);
    expect(can('edit', 'create_child')).toBe(true);
    expect(can('edit', 'share')).toBe(false);
    expect(can('full', 'delete')).toBe(true);
  });
});

describe('parseTaskRefs', () => {
  it('finds keys and short ids', () => {
    expect(parseTaskRefs('feat/OPS-142-board fix #k3x9a2bq and OPS-7')).toEqual({ keys: ['OPS-142', 'OPS-7'], shortIds: ['k3x9a2bq'] });
    expect(parseTaskRefs('nothing here, issue #12').shortIds).toEqual([]);
  });
});
