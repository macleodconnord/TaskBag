import { PRIORITIES, positionBetween } from '@app/shared';
import { dayDiff } from '@/lib/format';
import type { Status, Task, User } from '@/lib/types';

export interface TaskGroup {
  key: string;
  label: string;
  color?: string;
  status?: Status;
  /** what to set on a task dropped into this group */
  patch?: Record<string, unknown>;
  tasks: Task[];
}

const GROUP_ORDER = { open: 0, active: 1, done: 2, closed: 3 } as const;

/**
 * Group tasks for List/Board. With a single list's `statuses`, every status gets a column even
 * when empty. Across lists (space/folder/everything) statuses are merged by name.
 */
export function groupTasks(tasks: Task[], groupBy: string, opts: { statuses?: Status[]; users?: User[]; fields?: GroupableField[] } = {}): TaskGroup[] {
  if (groupBy === 'none') return [{ key: 'all', label: 'All tasks', tasks }];

  if (groupBy.startsWith('cf:')) {
    const field = opts.fields?.find((f) => f.id === groupBy.slice(3));
    if (field) return groupByField(tasks, field, opts.users ?? []);
    return [{ key: 'all', label: 'All tasks', tasks }];
  }

  if (groupBy === 'status') {
    if (opts.statuses) {
      return opts.statuses.map((s) => ({
        key: s.id, label: s.name, color: s.color, status: s, patch: { statusId: s.id },
        tasks: tasks.filter((t) => t.statusId === s.id),
      }));
    }
    const map = new Map<string, TaskGroup & { order: number }>();
    for (const t of tasks) {
      const s = t.status;
      const k = s ? `${GROUP_ORDER[s.group]}:${s.name.toLowerCase()}` : 'none';
      if (!map.has(k)) map.set(k, { key: k, label: s?.name ?? 'No status', color: s?.color, status: s ?? undefined, tasks: [], order: s ? GROUP_ORDER[s.group] * 100 + s.position : 999 });
      map.get(k)!.tasks.push(t);
    }
    return [...map.values()].sort((a, b) => a.order - b.order);
  }

  if (groupBy === 'assignee') {
    const map = new Map<string, TaskGroup>();
    for (const t of tasks) {
      const as = t.assignees.length ? t.assignees : [null];
      for (const a of as) {
        const k = a?.id ?? 'none';
        if (!map.has(k)) map.set(k, { key: k, label: a?.displayName ?? 'Unassigned', patch: { assigneeIds: a ? [a.id] : [] }, tasks: [] });
        map.get(k)!.tasks.push(t);
      }
    }
    return [...map.values()].sort((a, b) => (a.key === 'none' ? 1 : b.key === 'none' ? -1 : a.label.localeCompare(b.label)));
  }

  if (groupBy === 'priority') {
    const groups: TaskGroup[] = [...PRIORITIES.map((p) => ({ key: String(p.value), label: p.label, color: p.color, patch: { priority: p.value }, tasks: [] as Task[] })),
      { key: 'none', label: 'No priority', patch: { priority: null }, tasks: [] }];
    for (const t of tasks) groups.find((g) => g.key === String(t.priority ?? 'none'))!.tasks.push(t);
    return groups;
  }

  if (groupBy === 'due') {
    const buckets: Array<[string, string, (d: number | null) => boolean]> = [
      ['overdue', 'Overdue', (d) => d !== null && d < 0],
      ['today', 'Today', (d) => d === 0],
      ['tomorrow', 'Tomorrow', (d) => d === 1],
      ['week', 'Next 7 days', (d) => d !== null && d > 1 && d <= 7],
      ['later', 'Later', (d) => d !== null && d > 7],
      ['none', 'No due date', (d) => d === null],
    ];
    return buckets.map(([key, label, test]) => ({ key, label, tasks: tasks.filter((t) => test(t.dueAt ? dayDiff(t.dueAt) : null)) }));
  }

  if (groupBy === 'tag') {
    const map = new Map<string, TaskGroup>();
    for (const t of tasks) {
      for (const tag of t.tags.length ? t.tags : [null]) {
        const k = tag?.name.toLowerCase() ?? 'none';
        if (!map.has(k)) map.set(k, { key: k, label: tag?.name ?? 'No tags', color: tag?.color, tasks: [] });
        map.get(k)!.tasks.push(t);
      }
    }
    return [...map.values()];
  }

  if (groupBy === 'list') {
    const map = new Map<string, TaskGroup>();
    for (const t of tasks) {
      if (!map.has(t.listId)) map.set(t.listId, { key: t.listId, label: (t.listName as string | undefined) ?? 'List', patch: undefined, tasks: [] });
      map.get(t.listId)!.tasks.push(t);
    }
    return [...map.values()];
  }
  return [{ key: 'all', label: 'All tasks', tasks }];
}

/** Fractional position for a task dropped at `index` among `siblings` (already excluding the dragged task). */
export function positionAt(siblings: Task[], index: number): string {
  const before = index > 0 ? siblings[index - 1]?.position ?? null : null;
  const after = siblings[index]?.position ?? null;
  try {
    return positionBetween(before, after && before && after <= before ? null : after);
  } catch {
    return positionBetween(before, null);
  }
}

export const isDone = (t: Task) => t.status?.group === 'done' || t.status?.group === 'closed';

/** Minimal shape of a custom field for grouping (see features/fields/public.tsx). */
export interface GroupableField { id: string; name: string; type: string; config: Record<string, unknown> }

/** Group by a custom field value (`task.fields[fieldId]`): options, labels, users, checkbox or plain value. */
function groupByField(tasks: Task[], field: GroupableField, users: User[]): TaskGroup[] {
  const options = (field.config?.options as Array<{ id: string; name?: string; label?: string; color?: string }> | undefined) ?? [];
  const map = new Map<string, TaskGroup>();
  const add = (key: string, label: string, t: Task, color?: string) => {
    if (!map.has(key)) map.set(key, { key, label, color, tasks: [] });
    map.get(key)!.tasks.push(t);
  };
  for (const t of tasks) {
    const raw = (t.fields as Record<string, unknown> | undefined)?.[field.id];
    const vals = (Array.isArray(raw) ? raw : raw === undefined || raw === null || raw === '' ? [] : [raw]).map(String);
    if (field.type === 'checkbox') { add(raw === true ? 'true' : 'false', raw === true ? 'Checked' : 'Unchecked', t); continue; }
    if (!vals.length) { add('none', `No ${field.name}`, t); continue; }
    for (const v of vals) {
      const opt = options.find((o) => o.id === v);
      const user = field.type === 'user' ? users.find((u) => u.id === v) : undefined;
      add(v, opt ? opt.name ?? opt.label ?? v : user ? user.displayName : v, t, opt?.color);
    }
  }
  const order = (k: string) => { const i = options.findIndex((o) => o.id === k); return k === 'none' ? 1e6 : i < 0 ? 1e5 : i; };
  return [...map.values()].sort((a, b) => order(a.key) - order(b.key) || a.label.localeCompare(b.label));
}
