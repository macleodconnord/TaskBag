import { useMutation, useQueryClient } from '@tanstack/react-query';
import { GitMerge } from 'lucide-react';
import { useState } from 'react';
import { api } from '@/lib/api';
import { keys } from '@/lib/queries';
import type { ListDetail } from '@/lib/types';
import { StatusDot } from '@/components/pickers';
import { toast } from '@/components/toast';
import { Button, MenuItem, Modal, cx } from '@/components/ui';
import { openOverlay } from '@/features/fields/overlay';

/** List "⋯" menu items for integration settings (e.g. Gitea PR merged → status). */
export function ListIntegrationMenuItems({ list, onDone }: { list: ListDetail; onDone: () => void }) {
  return (
    <MenuItem
      icon={<GitMerge className="size-4" />}
      onClick={() => {
        onDone();
        // rendered in its own root so it survives the menu popover closing
        openOverlay((close) => <PrMergedDialog list={list} onClose={close} />);
      }}
    >
      When a PR merges…
    </MenuItem>
  );
}

function PrMergedDialog({ list, onClose }: { list: ListDetail; onClose: () => void }) {
  const qc = useQueryClient();
  const current = (list.settings?.giteaPrMergedStatusId as string | null | undefined) ?? '';
  const [value, setValue] = useState(current);
  const save = useMutation({
    mutationFn: () => api.patch(`/hierarchy/lists/${list.id}`, { settings: { giteaPrMergedStatusId: value || null } }),
    onSuccess: () => {
      toast.ok('Saved');
      void qc.invalidateQueries({ queryKey: keys.list(list.id) });
      onClose();
    },
  });
  const choices = [{ id: '', name: 'Do nothing', color: '', group: 'open' as const }, ...list.statuses];
  return (
    <Modal
      open
      onClose={onClose}
      title="When a linked pull request merges"
      width={440}
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" loading={save.isPending} disabled={value === current} onClick={() => save.mutate()}>Save</Button></>}
    >
      <p className="mb-3 text-sm text-muted">
        Tasks in <b>{list.name}</b> that are referenced by a Gitea pull request (e.g. <span className="font-mono">{list.path.space.keyPrefix}-123</span> in the branch or title) move to this status when it merges.
      </p>
      <div className="space-y-1">
        {choices.map((s) => (
          <label key={s.id || 'none'} className={cx('flex cursor-pointer items-center gap-2 rounded-md border px-2.5 py-1.5 text-sm', value === s.id ? 'border-accent-500 bg-accent-50 dark:bg-accent-500/10' : 'border-app hover-bg')}>
            <input type="radio" className="accent-accent-600" name="pr-merged-status" checked={value === s.id} onChange={() => setValue(s.id)} />
            {s.id ? <StatusDot status={s} /> : null}
            <span className={s.id ? '' : 'text-muted'}>{s.name}</span>
          </label>
        ))}
      </div>
    </Modal>
  );
}
