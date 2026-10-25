import { Check } from 'lucide-react';
import { useMemo, type ReactNode } from 'react';
import { useList, useTree } from '@/lib/queries';
import type { Status, Task } from '@/lib/types';
import { StatusDot, StatusPicker, StatusPill } from '@/components/pickers';
import { Loading, MenuItem, MenuLabel, Popover } from '@/components/ui';

export const canEdit = (t: Task) => t._perms.level === 'edit' || t._perms.level === 'full';

/** listId → { spaceId, name } from the sidebar tree. */
export function useListIndex() {
  const { data: tree } = useTree();
  return useMemo(() => {
    const m = new Map<string, { spaceId: string; name: string }>();
    for (const s of tree?.spaces ?? []) for (const l of [...s.lists, ...s.folders.flatMap((f) => f.lists)]) m.set(l.id, { spaceId: s.id, name: l.name });
    return m;
  }, [tree]);
}

/**
 * Status picker for any task. With the scope's `statuses` (single list) it's the normal picker;
 * across lists it loads the task's own list statuses when opened.
 */
export function TaskStatusPicker({ task, statuses, onChange, trigger }: {
  task: Task; statuses?: Status[]; onChange: (statusId: string) => void; trigger?: (s: Status | null | undefined) => ReactNode;
}) {
  const show = trigger ?? ((s) => <StatusPill status={s ?? undefined} />);
  if (!canEdit(task)) return <>{show(task.status)}</>;
  if (statuses) return <StatusPicker statuses={statuses} value={task.statusId} onChange={onChange} trigger={(s) => show(s ?? task.status)} />;
  return (
    <Popover width={220} trigger={(p) => <button {...p} className="inline-flex items-center rounded focus-visible:outline-2" title="Change status">{show(task.status)}</button>}>
      {(close) => <LazyStatusMenu listId={task.listId} value={task.statusId} onPick={(id) => { onChange(id); close(); }} />}
    </Popover>
  );
}

function LazyStatusMenu({ listId, value, onPick }: { listId: string; value: string; onPick: (id: string) => void }) {
  const { data } = useList(listId);
  if (!data) return <Loading label="" />;
  return (
    <div className="max-h-80 overflow-y-auto">
      {(['open', 'active', 'done', 'closed'] as const).map((g) => {
        const items = data.statuses.filter((s) => s.group === g);
        if (!items.length) return null;
        return (
          <div key={g}>
            <MenuLabel>{g}</MenuLabel>
            {items.map((s) => (
              <MenuItem key={s.id} icon={<StatusDot status={s} />} active={s.id === value} onClick={() => onPick(s.id)} right={s.id === value ? <Check className="size-4" /> : null}>{s.name}</MenuItem>
            ))}
          </div>
        );
      })}
    </div>
  );
}
