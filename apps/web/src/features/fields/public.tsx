/**
 * Public contract of the custom-fields feature, used by views (table columns, filters, sort).
 * Keep these names and signatures stable.
 */
import type { FieldType } from '@app/shared';
import { useQuery } from '@tanstack/react-query';
import { SlidersHorizontal } from 'lucide-react';
import { atLeast } from '@app/shared';
import { MenuItem } from '@/components/ui';
import { api, qs } from '@/lib/api';
import { useTree } from '@/lib/queries';
import type { Task } from '@/lib/types';
import { FieldValueEditor, useSetFieldValue } from './editors';
import { openFieldManager } from './FieldManager';

export interface CustomField {
  id: string;
  name: string;
  type: FieldType;
  config: Record<string, unknown>;
  scopeType: 'space' | 'folder' | 'list';
  scopeId: string;
  required: boolean;
  position: number;
}

export type FieldScope = { type: 'space' | 'folder' | 'list' | 'everything'; id?: string };

export const fieldsKey = (scope: FieldScope) => ['fields', scope.type, scope.id ?? ''] as const;

/** Fields that apply to a scope (a list: its own + folder's + space's; a space/folder also includes fields of lists beneath it). */
export function useFieldsForScope(scope: { type: 'space' | 'folder' | 'list' | 'everything'; id?: string }): CustomField[] {
  const { data } = useQuery({
    queryKey: fieldsKey(scope),
    queryFn: () => api.get<CustomField[]>(`/fields${qs({ scopeType: scope.type, scopeId: scope.id })}`),
    enabled: scope.type === 'everything' || !!scope.id,
    staleTime: 30_000,
  });
  return data ?? [];
}

/** Display (and, when `editable`, inline-edit) one field value of a task, sized for a table cell. */
export function FieldValueCell({ field, task, editable }: { field: CustomField; task: Task; editable: boolean }) {
  const set = useSetFieldValue();
  const values = (task.fields as Record<string, unknown> | undefined) ?? {};
  const canEdit = editable && atLeast(task._perms?.level ?? 'none', 'edit');
  // space/folder views show fields of every list beneath; a field from elsewhere doesn't apply to this task
  const { data: tree } = useTree();
  let applies = true;
  if (field.scopeType === 'list') applies = field.scopeId === task.listId;
  else if (tree) {
    for (const s of tree.spaces) {
      const l = [...s.lists, ...s.folders.flatMap((f) => f.lists)].find((x) => x.id === task.listId);
      if (l) applies = field.scopeType === 'space' ? s.id === field.scopeId : l.folderId === field.scopeId;
    }
  }
  if (!applies) return <div className="h-7 px-1 text-sm text-subtle" title="This field does not apply to this task's list" />;
  return (
    <FieldValueEditor
      field={field}
      value={values[field.id] ?? null}
      editable={canEdit}
      variant="cell"
      onChange={(value) => set.mutate({ taskId: task.id, fieldId: field.id, value })}
    />
  );
}

/** "Custom fields" menu item (list/folder/space "⋯" menus): opens the field manager for that scope. */
export function ManageFieldsMenuItem({ scope, onDone }: { scope: { type: 'space' | 'folder' | 'list'; id: string; name?: string }; onDone?: () => void }) {
  return (
    <MenuItem icon={<SlidersHorizontal className="size-4" />} onClick={() => { onDone?.(); openFieldManager(scope); }}>
      Custom fields
    </MenuItem>
  );
}

export { formatFieldValue } from './editors';
