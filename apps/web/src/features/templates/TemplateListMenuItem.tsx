import { useQueryClient } from '@tanstack/react-query';
import { LayoutTemplate } from 'lucide-react';
import { useNavigate } from 'react-router';
import { MenuItem } from '@/components/ui';
import { api } from '@/lib/api';
import { keys, useMe } from '@/lib/queries';
import { openSaveTemplate, openTemplatePicker } from './TemplatePicker';

/** "+ List from template" item in the sidebar's add menus. Hidden for guests. */
export function TemplateListMenuItem({ spaceId, folderId, onDone }: { spaceId: string; folderId: string | null; onDone: () => void }) {
  const { data: me } = useMe();
  const qc = useQueryClient();
  const nav = useNavigate();
  if (!me || me.user.role === 'guest') return null;
  return (
    <MenuItem
      icon={<LayoutTemplate className="size-4" />}
      onClick={() => {
        onDone();
        openTemplatePicker({
          kind: 'list',
          title: 'New list from template',
          confirmLabel: 'Create list',
          askName: true,
          onPick: async (t, name) => {
            const list = await api.post<{ id: string }>('/hierarchy/lists', { spaceId, folderId, name, templateId: t.id });
            await qc.invalidateQueries({ queryKey: keys.tree });
            nav(`/l/${list.id}`);
          },
        });
      }}
    >
      List from template
    </MenuItem>
  );
}

/** List "⋯" menu item: save the list (statuses, list fields, tasks) as a template. For the list menu owner to wire in. */
export function SaveListAsTemplateMenuItem({ listId, listName, onDone }: { listId: string; listName: string; onDone?: () => void }) {
  const { data: me } = useMe();
  if (!me || me.user.role === 'guest') return null;
  return (
    <MenuItem icon={<LayoutTemplate className="size-4" />} onClick={() => { onDone?.(); openSaveTemplate({ kind: 'list', sourceId: listId, defaultName: listName }); }}>
      Save list as template
    </MenuItem>
  );
}
