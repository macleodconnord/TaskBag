import { atLeast } from '@app/shared';
import { Settings2, SlidersHorizontal } from 'lucide-react';
import { useState } from 'react';
import { useTree } from '@/lib/queries';
import type { TaskDetail } from '@/lib/types';
import { FieldValueEditor, isEmptyValue, useSetFieldValue } from './editors';
import { FIELD_TYPE_META, openFieldManager } from './FieldManager';
import type { CustomField } from './public';

const COLLAPSE_AFTER = 8;

/** Custom field values in task detail, with inline editors per type and a "Manage fields" entry. */
export function TaskFieldsSection({ task }: { task: TaskDetail }) {
  const defs = (task.fieldDefinitions as CustomField[] | undefined) ?? [];
  const values = (task.fields as Record<string, unknown> | undefined) ?? {};
  const set = useSetFieldValue();
  const { data: tree } = useTree();
  const [showEmpty, setShowEmpty] = useState(false);
  const canEdit = atLeast(task.level, 'edit');
  const listId = task.path?.list.id ?? task.listId;
  const listLevel = tree?.spaces.flatMap((s) => [...s.lists, ...s.folders.flatMap((f) => f.lists)]).find((l) => l.id === listId)?._perms.level ?? 'none';
  const canManage = listLevel === 'full';

  if (!defs.length && !canManage) return null;
  const manage = () => openFieldManager({ type: 'list', id: listId, name: task.path?.list.name });

  const filled = defs.filter((f) => !isEmptyValue(values[f.id]) || f.required);
  const collapsible = defs.length > COLLAPSE_AFTER && filled.length < defs.length;
  const shown = collapsible && !showEmpty ? filled : defs;

  return (
    <section className="mt-6">
      <div className="mb-2 flex items-center gap-2">
        <SlidersHorizontal className="size-4 text-muted" />
        <h3 className="text-sm font-semibold">Fields</h3>
        {canManage && (
          <button onClick={manage} className="ml-auto inline-flex items-center gap-1 text-xs text-muted hover:text-app">
            <Settings2 className="size-3.5" />Manage fields
          </button>
        )}
      </div>
      {!defs.length ? (
        <button onClick={manage} className="w-full rounded-lg border border-dashed border-app px-3 py-3 text-left text-sm text-muted hover-bg">
          No custom fields on this list yet. Add fields like budget, client or a score.
        </button>
      ) : (
        <div className="rounded-lg border border-app">
          <div className="grid grid-cols-[minmax(110px,160px)_1fr] items-center gap-x-3 gap-y-0.5 px-2 py-1.5 text-sm">
            {shown.map((f) => {
              const v = values[f.id];
              const missing = f.required && isEmptyValue(v);
              return (
                <div key={f.id} className="contents">
                  <div className="flex min-w-0 items-center gap-1.5 py-0.5 text-muted" title={f.type === 'formula' ? `Formula: ${String(f.config.expression ?? '')}` : FIELD_TYPE_META[f.type]?.label}>
                    <span className="shrink-0">{FIELD_TYPE_META[f.type]?.icon}</span>
                    <span className="truncate">{f.name}</span>
                    {missing && <span className="text-red-600 dark:text-red-400" title="Required">*</span>}
                  </div>
                  <div className="min-w-0">
                    <FieldValueEditor
                      field={f}
                      value={v ?? null}
                      editable={canEdit}
                      variant="detail"
                      onChange={(value) => set.mutate({ taskId: task.id, fieldId: f.id, value })}
                    />
                  </div>
                </div>
              );
            })}
          </div>
          {collapsible && (
            <button onClick={() => setShowEmpty(!showEmpty)} className="w-full border-t border-app px-3 py-1.5 text-left text-xs text-muted hover-bg">
              {showEmpty ? 'Hide empty fields' : `Show ${defs.length - filled.length} empty field${defs.length - filled.length === 1 ? '' : 's'}`}
            </button>
          )}
        </div>
      )}
    </section>
  );
}
