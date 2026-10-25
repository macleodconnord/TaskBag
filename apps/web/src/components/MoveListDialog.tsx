import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '@/lib/api';
import { useTree } from '@/lib/queries';
import type { TreeList } from '@/lib/types';
import { Button, Field, Modal, Select } from './ui';
import { toast } from './toast';

export function MoveListDialog({ list, onClose }: { list: TreeList; onClose: () => void }) {
  const { data: tree } = useTree();
  const qc = useQueryClient();
  const [target, setTarget] = useState(`${list.spaceId}:${list.folderId ?? ''}`);
  const [busy, setBusy] = useState(false);
  const options = (tree?.spaces ?? []).filter((s) => s._perms.level === 'edit' || s._perms.level === 'full').flatMap((s) => [
    { value: `${s.id}:`, label: s.name },
    ...s.folders.filter((f) => f._perms.level === 'edit' || f._perms.level === 'full').map((f) => ({ value: `${s.id}:${f.id}`, label: `${s.name} › ${f.name}` })),
  ]);
  const save = async () => {
    const [spaceId, folderId] = target.split(':');
    setBusy(true);
    try {
      await api.patch(`/hierarchy/lists/${list.id}`, { spaceId, folderId: folderId || null });
      toast.ok('List moved');
      void qc.invalidateQueries();
      onClose();
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal open onClose={onClose} title={`Move “${list.name}”`} width={420}
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" loading={busy} onClick={save}>Move</Button></>}>
      <Field label="Destination">
        <Select value={target} onChange={(e) => setTarget(e.target.value)}>
          {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </Select>
      </Field>
      <p className="mt-2 text-xs text-muted">Moving to another space keeps the list’s statuses. Tags from the old space are removed.</p>
    </Modal>
  );
}
