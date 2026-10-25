import { FIELD_TYPES, validateFormula, type FieldType } from '@app/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AlignLeft, Archive, ArchiveRestore, ArrowDown, ArrowUp, AtSign, Calculator, Calendar, CheckSquare, ChevronDown, CircleDollarSign,
  Gauge, Hash, Link, Link2, ListChecks, Pencil, Phone, Plus, Star, Tags, Trash2, User, X,
} from 'lucide-react';
import { useMemo, useState, type ReactNode } from 'react';
import { ColorSwatches } from '@/components/pickers';
import { toast } from '@/components/toast';
import { Badge, Button, Checkbox, cx, Empty, Field, IconButton, Input, Loading, Modal, Popover, Select, Textarea, useDialogs } from '@/components/ui';
import { api, qs } from '@/lib/api';
import { useTree } from '@/lib/queries';
import type { Tree } from '@/lib/types';
import { openOverlay } from './overlay';
import type { FieldOption } from './editors';

export type ManagedScope = { type: 'space' | 'folder' | 'list'; id: string; name?: string };

interface FieldDef {
  id: string;
  name: string;
  type: FieldType;
  config: Record<string, unknown>;
  scopeType: 'space' | 'folder' | 'list';
  scopeId: string;
  required: boolean;
  position: number;
  archivedAt?: string | null;
}

export const FIELD_TYPE_META: Record<FieldType, { label: string; icon: ReactNode }> = {
  text: { label: 'Text', icon: <AlignLeft className="size-4" /> },
  number: { label: 'Number', icon: <Hash className="size-4" /> },
  currency: { label: 'Money', icon: <CircleDollarSign className="size-4" /> },
  dropdown: { label: 'Dropdown', icon: <ChevronDown className="size-4" /> },
  labels: { label: 'Labels', icon: <Tags className="size-4" /> },
  date: { label: 'Date', icon: <Calendar className="size-4" /> },
  checkbox: { label: 'Checkbox', icon: <CheckSquare className="size-4" /> },
  user: { label: 'People', icon: <User className="size-4" /> },
  url: { label: 'Website', icon: <Link className="size-4" /> },
  email: { label: 'Email', icon: <AtSign className="size-4" /> },
  phone: { label: 'Phone', icon: <Phone className="size-4" /> },
  rating: { label: 'Rating', icon: <Star className="size-4" /> },
  progress: { label: 'Progress', icon: <Gauge className="size-4" /> },
  relationship: { label: 'Relationship', icon: <Link2 className="size-4" /> },
  formula: { label: 'Formula', icon: <Calculator className="size-4" /> },
};

const OPTION_COLORS = ['#ef4444', '#f97316', '#eab308', '#22c55e', '#14b8a6', '#3b82f6', '#6366f1', '#a855f7', '#ec4899', '#64748b'];

/** Open the field manager for a space, folder or list (works from any menu; survives the menu closing). */
export function openFieldManager(scope: ManagedScope) {
  openOverlay((close) => <FieldManagerModal scope={scope} onClose={close} />);
}

function scopeInfo(tree: Tree | undefined, scope: ManagedScope) {
  for (const s of tree?.spaces ?? []) {
    if (scope.type === 'space' && s.id === scope.id) return { name: s.name, level: s._perms.level, chain: [] as ManagedScope[] };
    for (const f of s.folders) {
      if (scope.type === 'folder' && f.id === scope.id) return { name: f.name, level: f._perms.level, chain: [{ type: 'space' as const, id: s.id, name: s.name }] };
      for (const l of f.lists) if (scope.type === 'list' && l.id === scope.id) return { name: l.name, level: l._perms.level, chain: [{ type: 'space' as const, id: s.id, name: s.name }, { type: 'folder' as const, id: f.id, name: f.name }] };
    }
    for (const l of s.lists) if (scope.type === 'list' && l.id === scope.id) return { name: l.name, level: l._perms.level, chain: [{ type: 'space' as const, id: s.id, name: s.name }] };
  }
  return { name: scope.name ?? '', level: 'none' as const, chain: [] as ManagedScope[] };
}

function FieldManagerModal({ scope, onClose }: { scope: ManagedScope; onClose: () => void }) {
  const qc = useQueryClient();
  const { data: tree } = useTree();
  const info = scopeInfo(tree, scope);
  const canManage = info.level === 'full';
  const own = useQuery({
    queryKey: ['fields-manage', scope.type, scope.id],
    queryFn: () => api.get<FieldDef[]>(`/fields${qs({ scopeType: scope.type, scopeId: scope.id, exact: true, includeArchived: true })}`),
  });
  const applicable = useQuery({
    queryKey: ['fields', scope.type === 'list' ? 'list' : scope.type, scope.id],
    queryFn: () => api.get<FieldDef[]>(`/fields${qs({ scopeType: scope.type, scopeId: scope.id })}`),
  });
  const [editing, setEditing] = useState<FieldDef | 'new' | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const { confirm } = useDialogs();

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['fields-manage'] });
    void qc.invalidateQueries({ queryKey: ['fields'] });
    void qc.invalidateQueries({ predicate: (q) => q.queryKey[0] === 'tasks' || q.queryKey[0] === 'task' });
  };
  const run = async (fn: () => Promise<unknown>, okMsg?: string) => {
    try {
      await fn();
      if (okMsg) toast.ok(okMsg);
      refresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Something went wrong');
    }
  };

  const fields = own.data ?? [];
  const active = fields.filter((f) => !f.archivedAt);
  const archived = fields.filter((f) => f.archivedAt);
  const inherited = (applicable.data ?? []).filter((f) => info.chain.some((c) => c.type === f.scopeType && c.id === f.scopeId));
  const namesForFormula = useMemo(() => [...inherited, ...active].map((f) => f.name), [inherited, active]);

  const move = (i: number, dir: -1 | 1) => {
    const ids = active.map((f) => f.id);
    const j = i + dir;
    if (j < 0 || j >= ids.length) return;
    [ids[i], ids[j]] = [ids[j], ids[i]];
    void run(() => api.post('/fields/reorder', { scopeType: scope.type, scopeId: scope.id, ids }));
  };

  return (
    <Modal open onClose={onClose} width={640} title={<span>Custom fields <span className="font-normal text-muted">· {scope.type} “{info.name}”</span></span>}>
      {editing ? (
        <FieldForm
          scope={scope}
          field={editing === 'new' ? null : editing}
          names={namesForFormula.filter((n) => editing === 'new' || n !== editing.name)}
          onCancel={() => setEditing(null)}
          onSaved={() => { setEditing(null); refresh(); }}
        />
      ) : (
        <div className="space-y-4">
          <p className="text-sm text-muted">
            Fields defined here apply to every task in this {scope.type}{scope.type !== 'list' ? ' and the lists inside it' : ''}.
            {!canManage && ' You need full access to change them.'}
          </p>
          {own.isLoading ? <Loading /> : (
            <div className="divide-y divide-[var(--border)] rounded-lg border border-app">
              {!active.length && <Empty title="No fields yet">Add a field to track things like cost, priority score or a client name.</Empty>}
              {active.map((f, i) => (
                <div key={f.id} className="group flex items-center gap-2 px-3 py-2 text-sm">
                  <span className="text-muted">{FIELD_TYPE_META[f.type]?.icon}</span>
                  <span className="min-w-0 flex-1 truncate font-medium">{f.name}</span>
                  {f.required && <Badge>required</Badge>}
                  <span className="text-xs text-subtle">{FIELD_TYPE_META[f.type]?.label}</span>
                  {canManage && (
                    <span className="flex items-center gap-0.5">
                      <IconButton size="sm" label="Move up" disabled={i === 0} onClick={() => move(i, -1)}><ArrowUp className="size-3.5" /></IconButton>
                      <IconButton size="sm" label="Move down" disabled={i === active.length - 1} onClick={() => move(i, 1)}><ArrowDown className="size-3.5" /></IconButton>
                      <IconButton size="sm" label="Edit" onClick={() => setEditing(f)}><Pencil className="size-3.5" /></IconButton>
                      <IconButton size="sm" label="Archive" onClick={() => void run(() => api.patch(`/fields/${f.id}`, { archived: true }), `“${f.name}” archived`)}><Archive className="size-3.5" /></IconButton>
                    </span>
                  )}
                </div>
              ))}
            </div>
          )}
          {canManage && <Button variant="primary" onClick={() => setEditing('new')}><Plus className="size-4" />Add field</Button>}

          {inherited.length > 0 && (
            <div>
              <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-subtle">Inherited</div>
              <div className="flex flex-wrap gap-1.5">
                {inherited.map((f) => {
                  const from = info.chain.find((c) => c.type === f.scopeType && c.id === f.scopeId);
                  return (
                    <span key={f.id} className="inline-flex items-center gap-1 rounded-md border border-app px-2 py-1 text-xs" title={`Defined on ${from?.type} “${from?.name}”`}>
                      <span className="text-muted">{FIELD_TYPE_META[f.type]?.icon}</span>{f.name}
                      <span className="text-subtle">· {from?.type}</span>
                    </span>
                  );
                })}
              </div>
            </div>
          )}

          {archived.length > 0 && (
            <div>
              <button className="text-xs font-medium text-muted hover:text-app" onClick={() => setShowArchived(!showArchived)}>
                {showArchived ? 'Hide' : 'Show'} archived ({archived.length})
              </button>
              {showArchived && (
                <div className="mt-1 divide-y divide-[var(--border)] rounded-lg border border-app">
                  {archived.map((f) => (
                    <div key={f.id} className="flex items-center gap-2 px-3 py-2 text-sm text-muted">
                      <span>{FIELD_TYPE_META[f.type]?.icon}</span>
                      <span className="flex-1 truncate line-through">{f.name}</span>
                      {canManage && (
                        <>
                          <IconButton size="sm" label="Restore" onClick={() => void run(() => api.patch(`/fields/${f.id}`, { archived: false }), 'Field restored')}><ArchiveRestore className="size-3.5" /></IconButton>
                          <IconButton size="sm" label="Delete permanently" onClick={async () => {
                            if (await confirm({ title: `Delete “${f.name}”?`, body: 'The field and every value stored in it are removed permanently.', confirm: 'Delete', danger: true })) {
                              void run(() => api.delete(`/fields/${f.id}`), 'Field deleted');
                            }
                          }}><Trash2 className="size-3.5 text-red-600 dark:text-red-400" /></IconButton>
                        </>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </Modal>
  );
}

function FieldForm({ scope, field, names, onCancel, onSaved }: { scope: ManagedScope; field: FieldDef | null; names: string[]; onCancel: () => void; onSaved: () => void }) {
  const [name, setName] = useState(field?.name ?? '');
  const [type, setType] = useState<FieldType>(field?.type ?? 'text');
  const [config, setConfig] = useState<Record<string, unknown>>(field?.config ?? {});
  const [required, setRequired] = useState(field?.required ?? false);
  const [saving, setSaving] = useState(false);
  const formulaError = type === 'formula' ? (String(config.expression ?? '').trim() ? validateFormula(String(config.expression), [...names, 'due_date', 'start_date', 'time_estimate']) : 'Enter an expression') : null;

  const save = async () => {
    setSaving(true);
    try {
      if (field) await api.patch(`/fields/${field.id}`, { name, config, required });
      else await api.post('/fields', { name, type, config, required, scopeType: scope.type, scopeId: scope.id });
      toast.ok(field ? 'Field saved' : 'Field created');
      onSaved();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not save');
    } finally {
      setSaving(false);
    }
  };

  return (
    <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); if (name.trim() && !formulaError) void save(); }}>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Name"><Input autoFocus value={name} onChange={(e) => setName(e.target.value)} maxLength={100} placeholder="e.g. Budget" /></Field>
        <Field label="Type" hint={field ? '(can’t be changed)' : undefined}>
          {field ? (
            <div className="flex h-8 items-center gap-2 text-sm text-muted">{FIELD_TYPE_META[type].icon}{FIELD_TYPE_META[type].label}</div>
          ) : (
            <Popover width={260} trigger={(p) => (
              <button {...p} type="button" className="flex h-8 w-full items-center gap-2 rounded-md border border-app bg-app px-2.5 text-sm hover-bg">
                <span className="text-muted">{FIELD_TYPE_META[type].icon}</span>{FIELD_TYPE_META[type].label}<ChevronDown className="ml-auto size-4 text-subtle" />
              </button>
            )}>
              {(close) => (
                <div className="grid grid-cols-2 gap-0.5">
                  {FIELD_TYPES.map((t) => (
                    <button key={t} type="button" onClick={() => { setType(t); setConfig({}); close(); }}
                      className={cx('flex items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover-bg', t === type && 'bg-muted')}>
                      <span className="text-muted">{FIELD_TYPE_META[t].icon}</span>{FIELD_TYPE_META[t].label}
                    </button>
                  ))}
                </div>
              )}
            </Popover>
          )}
        </Field>
      </div>

      <TypeConfig type={type} config={config} setConfig={setConfig} names={names} formulaError={formulaError} />

      {type !== 'formula' && <Checkbox checked={required} onChange={setRequired} label={<span>Required <span className="text-subtle">(shown with a marker in task detail)</span></span>} />}

      <div className="flex justify-end gap-2 border-t border-app pt-3">
        <Button type="button" onClick={onCancel}>Back</Button>
        <Button type="submit" variant="primary" loading={saving} disabled={!name.trim() || !!formulaError}>{field ? 'Save' : 'Create field'}</Button>
      </div>
    </form>
  );
}

function TypeConfig({ type, config, setConfig, names, formulaError }: {
  type: FieldType; config: Record<string, unknown>; setConfig: (c: Record<string, unknown>) => void; names: string[]; formulaError: string | null;
}) {
  const set = (k: string, v: unknown) => setConfig({ ...config, [k]: v });
  const { data: tree } = useTree();
  switch (type) {
    case 'dropdown': case 'labels':
      return <OptionsEditor options={(config.options as FieldOption[] | undefined) ?? []} onChange={(o) => set('options', o)} />;
    case 'currency':
      return (
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Currency"><Input value={String(config.currency ?? 'USD')} maxLength={3} onChange={(e) => set('currency', e.target.value.toUpperCase())} placeholder="USD" /></Field>
          <Field label="Decimals"><Select value={String(config.precision ?? 2)} onChange={(e) => set('precision', Number(e.target.value))}>{[0, 1, 2, 3, 4].map((n) => <option key={n}>{n}</option>)}</Select></Field>
        </div>
      );
    case 'number':
      return (
        <Field label="Decimals" className="sm:w-1/2">
          <Select value={config.precision === undefined ? '' : String(config.precision)} onChange={(e) => setConfig(e.target.value === '' ? {} : { precision: Number(e.target.value) })}>
            <option value="">Automatic</option>{[0, 1, 2, 3, 4, 5, 6].map((n) => <option key={n} value={n}>{n}</option>)}
          </Select>
        </Field>
      );
    case 'rating':
      return <Field label="Maximum stars" className="sm:w-1/2"><Select value={String(config.max ?? 5)} onChange={(e) => set('max', Number(e.target.value))}>{[3, 4, 5, 6, 7, 8, 9, 10].map((n) => <option key={n}>{n}</option>)}</Select></Field>;
    case 'date':
      return <Checkbox checked={!!config.includeTime} onChange={(v) => set('includeTime', v)} label="Include time" />;
    case 'user':
      return <Checkbox checked={config.multiple !== false} onChange={(v) => set('multiple', v)} label="Allow multiple people" />;
    case 'relationship': {
      const lists = (tree?.spaces ?? []).flatMap((s) => [...s.lists, ...s.folders.flatMap((f) => f.lists)].filter((l) => !l.navOnly).map((l) => ({ id: l.id, label: `${s.name} › ${l.name}` })));
      return (
        <Field label="Linked list" hint="(optional: limit choices to tasks in one list)">
          <Select value={String(config.targetListId ?? '')} onChange={(e) => set('targetListId', e.target.value || null)}>
            <option value="">Any task</option>
            {lists.map((l) => <option key={l.id} value={l.id}>{l.label}</option>)}
          </Select>
        </Field>
      );
    }
    case 'formula':
      return (
        <div className="space-y-2">
          <Field label="Expression">
            <Textarea rows={3} className="font-mono text-[13px]" value={String(config.expression ?? '')} onChange={(e) => set('expression', e.target.value)} placeholder="ROUND({Price} * {Qty}, 2)" />
          </Field>
          {formulaError && String(config.expression ?? '').trim() && <div className="text-xs text-red-600 dark:text-red-400">{formulaError}</div>}
          <div className="flex flex-wrap gap-1">
            {[...names, 'due_date', 'start_date', 'time_estimate'].map((n) => (
              <button key={n} type="button" className="rounded border border-app px-1.5 py-0.5 font-mono text-[11px] text-muted hover-bg hover:text-app" onClick={() => set('expression', `${String(config.expression ?? '')}{${n}}`)}>{`{${n}}`}</button>
            ))}
          </div>
          <p className="text-xs text-subtle">
            Operators <code>+ - * / %</code>, comparisons <code>= != &lt; &gt; &lt;= &gt;=</code>, and functions <code>IF(cond, a, b)</code>, <code>ROUND(x, digits)</code>, <code>MIN</code>, <code>MAX</code>, <code>ABS</code>, <code>DAYS(end, start)</code>, <code>TODAY()</code>. Empty values count as 0. Time estimate is in minutes.
          </p>
          <Field label="Decimals" className="sm:w-1/2">
            <Select value={config.precision === undefined ? '' : String(config.precision)} onChange={(e) => { const { precision: _p, ...rest } = config; setConfig(e.target.value === '' ? rest : { ...rest, precision: Number(e.target.value) }); }}>
              <option value="">Automatic</option>{[0, 1, 2, 3, 4].map((n) => <option key={n} value={n}>{n}</option>)}
            </Select>
          </Field>
        </div>
      );
  }
  return null;
}

function OptionsEditor({ options, onChange }: { options: FieldOption[]; onChange: (o: FieldOption[]) => void }) {
  const [draft, setDraft] = useState('');
  const add = () => {
    const n = draft.trim();
    if (!n) return;
    onChange([...options, { id: crypto.randomUUID(), name: n, color: OPTION_COLORS[options.length % OPTION_COLORS.length] }]);
    setDraft('');
  };
  const update = (i: number, patch: Partial<FieldOption>) => onChange(options.map((o, j) => (j === i ? { ...o, ...patch } : o)));
  const move = (i: number, d: -1 | 1) => {
    const next = [...options];
    const j = i + d;
    if (j < 0 || j >= next.length) return;
    [next[i], next[j]] = [next[j], next[i]];
    onChange(next);
  };
  return (
    <div>
      <div className="mb-1 flex items-center gap-1 text-xs font-medium text-muted"><ListChecks className="size-3.5" />Options</div>
      <div className="space-y-1">
        {options.map((o, i) => (
          <div key={o.id} className="flex items-center gap-1.5">
            <Popover width={200} trigger={(p) => <button {...p} type="button" aria-label="Color" className="size-6 shrink-0 rounded-full border border-app" style={{ backgroundColor: o.color }} />}>
              {(close) => <div className="p-1"><ColorSwatches value={o.color} onChange={(c) => { update(i, { color: c }); close(); }} /></div>}
            </Popover>
            <Input value={o.name} onChange={(e) => update(i, { name: e.target.value })} className="h-7" />
            <IconButton size="sm" label="Move up" disabled={i === 0} onClick={() => move(i, -1)}><ArrowUp className="size-3.5" /></IconButton>
            <IconButton size="sm" label="Move down" disabled={i === options.length - 1} onClick={() => move(i, 1)}><ArrowDown className="size-3.5" /></IconButton>
            <IconButton size="sm" label="Remove option" onClick={() => onChange(options.filter((_, j) => j !== i))}><X className="size-3.5" /></IconButton>
          </div>
        ))}
      </div>
      <div className="mt-1.5 flex gap-1.5">
        <Input className="h-7" placeholder="Add an option…" value={draft} onChange={(e) => setDraft(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); add(); } }} />
        <Button type="button" size="sm" onClick={add} disabled={!draft.trim()}><Plus className="size-3.5" />Add</Button>
      </div>
      {options.length > 0 && <p className="mt-1 text-xs text-subtle">Removing an option clears it from tasks that use it.</p>}
    </div>
  );
}
