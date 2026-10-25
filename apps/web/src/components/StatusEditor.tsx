import { STATUS_GROUPS, type StatusGroup } from '@app/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowDown, ArrowUp, Plus, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import type { ListDetail, Status } from '@/lib/types';
import { StatusDot } from './pickers';
import { Button, Input, Loading, Modal, Select } from './ui';
import { toast } from './toast';

type Row = { id?: string; name: string; color: string; group: StatusGroup };
const COLORS = ['#94a3b8', '#3b82f6', '#a855f7', '#f59e0b', '#ef4444', '#14b8a6', '#22c55e', '#475569'];

/** Edit a space's status set, or a list's override (with "use the space's statuses" to revert). */
export function StatusEditor({ type, id, name, onClose }: { type: 'space' | 'list'; id: string; name: string; onClose: () => void }) {
  const qc = useQueryClient();
  const { data } = useQuery({
    queryKey: ['status-editor', type, id],
    queryFn: async () => {
      if (type === 'space') {
        const s = await api.get<{ statuses: Status[] }>(`/hierarchy/spaces/${id}`);
        return { statuses: s.statuses, own: true };
      }
      const l = await api.get<ListDetail>(`/hierarchy/lists/${id}`);
      return { statuses: l.statuses, own: l.hasOwnStatuses };
    },
  });
  const [rows, setRows] = useState<Row[]>([]);
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    if (data) setRows(data.statuses.map((s) => ({ id: s.id, name: s.name, color: s.color, group: s.group })));
  }, [data]);

  const removed = (data?.statuses ?? []).filter((s) => !rows.some((r) => r.id === s.id));
  const move = (i: number, d: number) => setRows((r) => {
    const n = [...r];
    const [x] = n.splice(i, 1);
    n.splice(i + d, 0, x);
    return n;
  });

  const save = async () => {
    setSaving(true);
    try {
      await api.put(`/hierarchy/${type === 'space' ? 'spaces' : 'lists'}/${id}/statuses`, { statuses: rows, mapping });
      toast.ok('Statuses saved');
      void qc.invalidateQueries();
      onClose();
    } finally {
      setSaving(false);
    }
  };
  const revert = async () => {
    setSaving(true);
    try {
      await api.delete(`/hierarchy/lists/${id}/statuses`, { mapping: {} });
      toast.ok('List now uses the space statuses');
      void qc.invalidateQueries();
      onClose();
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal open onClose={onClose} title={`Statuses — ${name}`} width={560}
      footer={
        <>
          {type === 'list' && data?.own && <Button className="mr-auto" onClick={revert} disabled={saving}>Use the space’s statuses</Button>}
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={saving} onClick={save} disabled={!rows.length || rows.some((r) => !r.name.trim())}>Save</Button>
        </>
      }>
      {!data ? <Loading /> : (
        <div className="space-y-3">
          {type === 'list' && !data.own && <p className="text-sm text-muted">This list uses its space’s statuses. Saving here gives the list its own set.</p>}
          <div className="space-y-1.5">
            {rows.map((r, i) => (
              <div key={r.id ?? `new-${i}`} className="flex items-center gap-2">
                <StatusDot status={r} size={12} />
                <Input className="flex-1" value={r.name} onChange={(e) => setRows((rs) => rs.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))} />
                <Select className="w-24" value={r.group} onChange={(e) => setRows((rs) => rs.map((x, j) => (j === i ? { ...x, group: e.target.value as StatusGroup } : x)))}>
                  {STATUS_GROUPS.map((g) => <option key={g} value={g}>{g}</option>)}
                </Select>
                <input type="color" value={r.color} className="h-8 w-8 cursor-pointer rounded border border-app bg-transparent" onChange={(e) => setRows((rs) => rs.map((x, j) => (j === i ? { ...x, color: e.target.value } : x)))} />
                <button className="text-subtle hover:text-app disabled:opacity-30" disabled={i === 0} onClick={() => move(i, -1)} aria-label="Move up"><ArrowUp className="size-4" /></button>
                <button className="text-subtle hover:text-app disabled:opacity-30" disabled={i === rows.length - 1} onClick={() => move(i, 1)} aria-label="Move down"><ArrowDown className="size-4" /></button>
                <button className="text-subtle hover:text-red-600 disabled:opacity-30" disabled={rows.length <= 1} onClick={() => setRows((rs) => rs.filter((_, j) => j !== i))} aria-label="Remove"><Trash2 className="size-4" /></button>
              </div>
            ))}
          </div>
          <Button size="sm" onClick={() => setRows((r) => [...r, { name: 'New status', color: COLORS[r.length % COLORS.length], group: 'active' }])}><Plus className="size-3.5" />Add status</Button>
          {removed.length > 0 && (
            <div className="rounded-lg border border-amber-300 bg-amber-50 p-3 dark:border-amber-700 dark:bg-amber-950/40">
              <div className="mb-2 text-sm font-medium">Move tasks from removed statuses to:</div>
              {removed.map((s) => (
                <div key={s.id} className="mb-1.5 flex items-center gap-2 text-sm">
                  <StatusDot status={s} /> <span className="w-32 truncate">{s.name}</span> →
                  <Select className="flex-1" value={mapping[s.id] ?? ''} onChange={(e) => setMapping((m) => ({ ...m, [s.id]: e.target.value }))}>
                    <option value="">Automatic (same group)</option>
                    {rows.filter((r) => r.id).map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
                  </Select>
                </div>
              ))}
            </div>
          )}
          <p className="text-xs text-muted">Groups: <b>open</b> = not started, <b>active</b> = in progress, <b>done</b> and <b>closed</b> mark a task complete. Closed tasks are hidden by default.</p>
        </div>
      )}
    </Modal>
  );
}
