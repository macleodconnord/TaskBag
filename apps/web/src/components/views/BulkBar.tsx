import { PRIORITIES } from '@app/shared';
import { useQueryClient } from '@tanstack/react-query';
import { Archive, Calendar, Flag, FolderInput, Trash2, UserPlus, X, CircleDot } from 'lucide-react';
import { api } from '@/lib/api';
import { fromDateInput } from '@/lib/format';
import { refreshTasks, useTree } from '@/lib/queries';
import type { Status } from '@/lib/types';
import { StatusDot, UserSearchList } from '../pickers';
import { toast } from '../toast';
import { Button, Input, MenuItem, MenuLabel, Popover, useDialogs } from '../ui';

type BulkResult = { succeeded: number; failed: number; results: Array<{ id: string; ok: boolean; error?: string }> };

/** Bulk edit bar (V-08): per-task permission checks on the server, partial failures reported. */
export function BulkBar({ ids, statuses, onClear }: { ids: string[]; statuses?: Status[]; onClear: () => void }) {
  const qc = useQueryClient();
  const { data: tree } = useTree();
  const { confirm } = useDialogs();
  const run = async (action: 'update' | 'delete', update?: Record<string, unknown>) => {
    const r = await api.post<BulkResult>('/tasks/bulk', { taskIds: ids, action, update });
    refreshTasks(qc);
    if (r.failed) {
      const reasons = [...new Set(r.results.filter((x) => !x.ok).map((x) => x.error))].join('; ');
      toast.error(`${r.succeeded} updated, ${r.failed} skipped: ${reasons}`);
    } else toast.ok(`${r.succeeded} task${r.succeeded === 1 ? '' : 's'} updated`);
    onClear();
  };
  const lists = (tree?.spaces ?? []).flatMap((s) => [...s.lists, ...s.folders.flatMap((f) => f.lists)].filter((l) => !l.navOnly && (l._perms.level === 'edit' || l._perms.level === 'full')).map((l) => ({ ...l, spaceName: s.name })));

  return (
    <div className="fixed bottom-6 left-1/2 z-20 flex -translate-x-1/2 items-center gap-1 rounded-xl border border-app bg-app px-2 py-1.5 shadow-2xl">
      <span className="px-2 text-sm font-medium">{ids.length} selected</span>
      {statuses && (
        <Popover width={200} trigger={(p) => <Button {...p} variant="ghost" size="sm"><CircleDot className="size-4" />Status</Button>}>
          {(close) => statuses.map((s) => <MenuItem key={s.id} icon={<StatusDot status={s} />} onClick={() => { close(); void run('update', { statusId: s.id }); }}>{s.name}</MenuItem>)}
        </Popover>
      )}
      <Popover width={260} trigger={(p) => <Button {...p} variant="ghost" size="sm"><UserPlus className="size-4" />Assign</Button>}>
        {(close) => <UserSearchList selected={[]} onToggle={(uid) => { close(); void run('update', { addAssigneeIds: [uid] }); }} />}
      </Popover>
      <Popover width={200} trigger={(p) => <Button {...p} variant="ghost" size="sm"><Calendar className="size-4" />Due</Button>}>
        {(close) => (
          <div className="p-1">
            <Input type="date" onChange={(e) => { if (e.target.value) { close(); void run('update', { dueAt: fromDateInput(e.target.value) }); } }} />
            <MenuItem onClick={() => { close(); void run('update', { dueAt: null }); }}>Clear due date</MenuItem>
          </div>
        )}
      </Popover>
      <Popover width={170} trigger={(p) => <Button {...p} variant="ghost" size="sm"><Flag className="size-4" />Priority</Button>}>
        {(close) => (
          <>
            {PRIORITIES.map((pr) => <MenuItem key={pr.value} icon={<Flag className="size-4" style={{ color: pr.color, fill: pr.color }} />} onClick={() => { close(); void run('update', { priority: pr.value }); }}>{pr.label}</MenuItem>)}
            <MenuItem onClick={() => { close(); void run('update', { priority: null }); }}>Clear</MenuItem>
          </>
        )}
      </Popover>
      <Popover width={260} trigger={(p) => <Button {...p} variant="ghost" size="sm"><FolderInput className="size-4" />Move</Button>}>
        {(close) => (
          <div className="max-h-72 overflow-y-auto">
            <MenuLabel>Move to list</MenuLabel>
            {lists.map((l) => <MenuItem key={l.id} onClick={() => { close(); void run('update', { listId: l.id }); }}>{l.spaceName} › {l.name}</MenuItem>)}
          </div>
        )}
      </Popover>
      <Button variant="ghost" size="sm" onClick={() => void run('update', { archived: true })}><Archive className="size-4" />Archive</Button>
      <Button variant="ghost" size="sm" className="text-red-600" onClick={async () => { if (await confirm({ title: `Delete ${ids.length} tasks?`, body: 'They go to the trash and are removed after 30 days.', confirm: 'Delete', danger: true })) void run('delete'); }}><Trash2 className="size-4" />Delete</Button>
      <button className="ml-1 rounded p-1 text-subtle hover:text-app" onClick={onClear} aria-label="Clear selection"><X className="size-4" /></button>
    </div>
  );
}
