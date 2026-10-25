import type { ViewConfig, ViewType } from '@app/shared';
import { ArrowDown, ArrowDownUp, ArrowUp, Columns3, Eye, EyeOff, Plus, SlidersHorizontal, Trash2 } from 'lucide-react';
import type { CustomField } from '@/features/fields/public';
import { Button, Checkbox, IconButton, Label, MenuLabel, Popover, Select } from '@/components/ui';
import type { ScopeType } from './api';
import { allColumns, defaultColumns, SORT_FIELDS } from './config';

type Patch = (p: Partial<ViewConfig>) => void;

export function SortButton({ config, onChange, fields }: { config: ViewConfig; onChange: Patch; fields: CustomField[] }) {
  const options = [...SORT_FIELDS, ...fields.filter((f) => f.type !== 'formula').map((f) => ({ key: `cf:${f.id}`, label: f.name }))];
  const sort = config.sort;
  const set = (i: number, s: { field: string; dir: 'asc' | 'desc' }) => onChange({ sort: sort.map((x, j) => (j === i ? s : x)) });
  return (
    <Popover width={340} align="end" trigger={(p) => (
      <Button {...p} size="sm" variant={sort.length ? 'primary' : 'secondary'}><ArrowDownUp className="size-3.5" />Sort{sort.length ? ` · ${sort.length}` : ''}</Button>
    )}>
      <div className="p-2">
        {!sort.length && <div className="pb-2 text-sm text-muted">Manual order. Add a sort to order tasks by a field.</div>}
        <div className="flex flex-col gap-1.5">
          {sort.map((s, i) => (
            <div key={i} className="flex items-center gap-1.5">
              <span className="w-10 text-xs text-muted">{i === 0 ? 'Sort by' : 'then'}</span>
              <Select className="h-7 flex-1 text-xs" value={s.field} onChange={(e) => set(i, { ...s, field: e.target.value })} aria-label="Sort field">
                {options.map((o) => <option key={o.key} value={o.key}>{o.label}</option>)}
                {!options.some((o) => o.key === s.field) && <option value={s.field}>Unknown field</option>}
              </Select>
              <IconButton size="sm" label={s.dir === 'asc' ? 'Ascending' : 'Descending'} onClick={() => set(i, { ...s, dir: s.dir === 'asc' ? 'desc' : 'asc' })}>
                {s.dir === 'asc' ? <ArrowUp className="size-3.5" /> : <ArrowDown className="size-3.5" />}
              </IconButton>
              <IconButton size="sm" label="Remove sort" onClick={() => onChange({ sort: sort.filter((_, j) => j !== i) })}><Trash2 className="size-3.5" /></IconButton>
            </div>
          ))}
        </div>
        <div className="mt-2 flex items-center gap-1">
          {sort.length < 3 && (
            <Button size="sm" variant="ghost" onClick={() => onChange({ sort: [...sort, { field: options.find((o) => !sort.some((s) => s.field === o.key))?.key ?? 'name', dir: 'asc' }] })}>
              <Plus className="size-3.5" />Add sort
            </Button>
          )}
          {sort.length > 0 && <Button size="sm" variant="ghost" className="ml-auto" onClick={() => onChange({ sort: [] })}>Clear</Button>}
        </div>
      </div>
    </Popover>
  );
}

/** Show/hide and order columns (Table: every column; List: custom-field columns). */
export function ColumnsButton({ config, onChange, fields, scope, mode }: { config: ViewConfig; onChange: Patch; fields: CustomField[]; scope: ScopeType; mode: 'table' | 'list' }) {
  const all = allColumns(fields).filter((c) => mode === 'table' || c.field);
  const current = config.columns.length ? config.columns : defaultColumns(scope);
  const visible = current.filter((k) => all.some((c) => c.key === k));  // list mode: `all` holds only custom fields
  const hidden = all.filter((c) => !visible.includes(c.key));
  const move = (k: string, d: -1 | 1) => {
    const i = visible.indexOf(k);
    const j = i + d;
    if (j < 0 || j >= visible.length) return;
    const n = [...visible];
    [n[i], n[j]] = [n[j], n[i]];
    commit(n);
  };
  // keep table-only keys when editing from the List view, so switching type doesn't lose them
  const commit = (keys: string[]) => onChange({ columns: mode === 'list' ? [...current.filter((k) => !k.startsWith('cf:')), ...keys] : keys });
  if (mode === 'list' && !all.length) return null;
  return (
    <Popover width={280} align="end" trigger={(p) => <Button {...p} size="sm"><Columns3 className="size-3.5" />{mode === 'table' ? 'Columns' : 'Fields'}</Button>}>
      <div className="max-h-[60vh] overflow-y-auto">
        <MenuLabel>Shown</MenuLabel>
        {mode === 'table' && <Row label="Task name" fixed />}
        {visible.map((k, i) => {
          const c = all.find((x) => x.key === k)!;
          return (
            <Row key={k} label={c.label} shown onToggle={() => commit(visible.filter((x) => x !== k))}
              onUp={i > 0 ? () => move(k, -1) : undefined} onDown={i < visible.length - 1 ? () => move(k, 1) : undefined} />
          );
        })}
        {hidden.length > 0 && <MenuLabel>Hidden</MenuLabel>}
        {hidden.map((c) => <Row key={c.key} label={c.label} onToggle={() => commit([...visible, c.key])} />)}
        {mode === 'table' && config.columns.length > 0 && (
          <div className="border-t border-app p-1">
            <Button size="sm" variant="ghost" onClick={() => onChange({ columns: [], columnWidths: {} })}>Reset columns</Button>
          </div>
        )}
      </div>
    </Popover>
  );
}

function Row({ label, shown, fixed, onToggle, onUp, onDown }: { label: string; shown?: boolean; fixed?: boolean; onToggle?: () => void; onUp?: () => void; onDown?: () => void }) {
  return (
    <div className="group flex items-center gap-1 rounded-md px-2 py-1 text-sm hover-bg">
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {onUp && <IconButton size="sm" label="Move up" className="opacity-0 group-hover:opacity-100" onClick={onUp}><ArrowUp className="size-3.5" /></IconButton>}
      {onDown && <IconButton size="sm" label="Move down" className="opacity-0 group-hover:opacity-100" onClick={onDown}><ArrowDown className="size-3.5" /></IconButton>}
      {!fixed && (
        <IconButton size="sm" label={shown ? `Hide ${label}` : `Show ${label}`} onClick={onToggle}>
          {shown ? <Eye className="size-3.5" /> : <EyeOff className="size-3.5 text-subtle" />}
        </IconButton>
      )}
    </div>
  );
}

/** Group-by select + other display options. */
export function OptionsButton({ config, onChange, type, groups }: { config: ViewConfig; onChange: Patch; type: ViewType; groups: Array<{ value: string; label: string }> }) {
  const groupable = type === 'list' || type === 'board' || type === 'table';
  const dated = type === 'calendar' || type === 'gantt';
  return (
    <Popover width={250} align="end" trigger={(p) => <Button {...p} size="sm"><SlidersHorizontal className="size-3.5" />View</Button>}>
      <div className="flex flex-col gap-3 p-2">
        {groupable && (
          <div>
            <Label>Group by</Label>
            <Select className="h-7 text-xs" value={config.groupBy} onChange={(e) => onChange({ groupBy: e.target.value })}>
              {groups.map((g) => <option key={g.value} value={g.value}>{g.label}</option>)}
              {!groups.some((g) => g.value === config.groupBy) && <option value={config.groupBy}>Unknown</option>}
            </Select>
          </div>
        )}
        {type === 'calendar' && (
          <div>
            <Label>Show tasks on</Label>
            <Select className="h-7 text-xs" value={config.dateField} onChange={(e) => onChange({ dateField: e.target.value as ViewConfig['dateField'] })}>
              <option value="due_at">Due date</option>
              <option value="start_at">Start date</option>
            </Select>
          </div>
        )}
        <Checkbox checked={config.showClosed} onChange={(v) => onChange({ showClosed: v })} label={<span className="text-sm">Show closed tasks</span>} />
        <Checkbox checked={config.showSubtasks} onChange={(v) => onChange({ showSubtasks: v })} label={<span className="text-sm">Show subtasks as separate rows</span>} />
        {dated && <div className="text-xs text-subtle">Drag tasks to reschedule them.</div>}
      </div>
    </Popover>
  );
}
