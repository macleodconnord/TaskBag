import { useQuery, useQueryClient } from '@tanstack/react-query';
import { FileStack, LayoutTemplate, Search, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { toast } from '@/components/toast';
import { Button, cx, Empty, Field, IconButton, Input, Loading, Modal, Textarea, useDialogs } from '@/components/ui';
import { api, qs } from '@/lib/api';
import { timeAgo } from '@/lib/format';
import { useMe } from '@/lib/queries';
import { openOverlay } from '../fields/overlay';

export interface TemplateSummary {
  id: string;
  kind: 'task' | 'list';
  name: string;
  description: string | null;
  createdBy: string;
  createdByName: string | null;
  createdAt: string;
  taskCount: number;
  fieldCount: number;
}

export const templatesKey = (kind: 'task' | 'list') => ['templates', kind] as const;

/** Pick a template; for list templates also asks for the new list's name. */
export function openTemplatePicker(opts: {
  kind: 'task' | 'list';
  title: string;
  confirmLabel: string;
  askName?: boolean;
  onPick: (t: TemplateSummary, name: string) => Promise<void>;
}) {
  openOverlay((close) => <TemplatePickerModal {...opts} onClose={close} />);
}

function TemplatePickerModal({ kind, title, confirmLabel, askName, onPick, onClose }: {
  kind: 'task' | 'list'; title: string; confirmLabel: string; askName?: boolean;
  onPick: (t: TemplateSummary, name: string) => Promise<void>; onClose: () => void;
}) {
  const qc = useQueryClient();
  const { data: me } = useMe();
  const { confirm } = useDialogs();
  const { data = [], isLoading } = useQuery({ queryKey: templatesKey(kind), queryFn: () => api.get<TemplateSummary[]>(`/templates${qs({ kind })}`) });
  const [q, setQ] = useState('');
  const [sel, setSel] = useState<TemplateSummary | null>(null);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const shown = data.filter((t) => !q || `${t.name} ${t.description ?? ''}`.toLowerCase().includes(q.toLowerCase()));
  const isAdmin = me?.user.role === 'admin' || me?.user.role === 'owner';

  const go = async () => {
    if (!sel) return;
    setBusy(true);
    try {
      await onPick(sel, name.trim() || sel.name);
      onClose();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not use the template');
    } finally {
      setBusy(false);
    }
  };
  const remove = async (t: TemplateSummary) => {
    if (!(await confirm({ title: `Delete template “${t.name}”?`, body: 'Tasks and lists already created from it are not affected.', confirm: 'Delete', danger: true }))) return;
    try {
      await api.delete(`/templates/${t.id}`);
      if (sel?.id === t.id) setSel(null);
      void qc.invalidateQueries({ queryKey: ['templates'] });
      toast.ok('Template deleted');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not delete');
    }
  };

  return (
    <Modal open onClose={onClose} title={title} width={560} footer={
      <>
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="primary" disabled={!sel || (askName && !name.trim())} loading={busy} onClick={() => void go()}>{confirmLabel}</Button>
      </>
    }>
      <div className="space-y-3">
        <div className="relative">
          <Search className="pointer-events-none absolute left-2 top-2 size-4 text-subtle" />
          <Input autoFocus className="pl-7" placeholder="Search templates…" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        {isLoading ? <Loading /> : !data.length ? (
          <Empty icon={<LayoutTemplate className="size-8" />} title={`No ${kind} templates yet`}>
            {kind === 'task' ? 'Open a task, then “⋯” → “Save as template”.' : 'Use “Save list as template” from a list menu.'}
          </Empty>
        ) : (
          <div className="max-h-72 divide-y divide-[var(--border)] overflow-y-auto rounded-lg border border-app">
            {shown.map((t) => (
              <div
                key={t.id}
                role="button"
                tabIndex={0}
                onClick={() => { setSel(t); if (askName && !name) setName(t.name); }}
                onKeyDown={(e) => e.key === 'Enter' && setSel(t)}
                className={cx('group flex cursor-pointer items-start gap-2 px-3 py-2 text-sm hover-bg', sel?.id === t.id && 'bg-accent-500/10 ring-1 ring-inset ring-accent-500')}
              >
                <FileStack className="mt-0.5 size-4 shrink-0 text-muted" />
                <div className="min-w-0 flex-1">
                  <div className="truncate font-medium">{t.name}</div>
                  {t.description && <div className="truncate text-xs text-muted">{t.description}</div>}
                  <div className="text-xs text-subtle">
                    {t.taskCount} task{t.taskCount === 1 ? '' : 's'}{t.fieldCount ? ` · ${t.fieldCount} field${t.fieldCount === 1 ? '' : 's'}` : ''}
                    {' · '}{t.createdByName ?? 'someone'}, {timeAgo(t.createdAt)}
                  </div>
                </div>
                {(t.createdBy === me?.user.id || isAdmin) && (
                  <IconButton size="sm" label="Delete template" className="opacity-0 group-hover:opacity-100" onClick={(e) => { e.stopPropagation(); void remove(t); }}>
                    <Trash2 className="size-3.5" />
                  </IconButton>
                )}
              </div>
            ))}
            {!shown.length && <div className="px-3 py-4 text-center text-sm text-muted">No matches</div>}
          </div>
        )}
        {askName && sel && (
          <Field label={kind === 'list' ? 'List name' : 'Task name'}>
            <Input value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && void go()} />
          </Field>
        )}
      </div>
    </Modal>
  );
}

/** Save a task or list as a template (name + description). */
export function openSaveTemplate(opts: { kind: 'task' | 'list'; sourceId: string; defaultName: string }) {
  openOverlay((close) => <SaveTemplateModal {...opts} onClose={close} />);
}

function SaveTemplateModal({ kind, sourceId, defaultName, onClose }: { kind: 'task' | 'list'; sourceId: string; defaultName: string; onClose: () => void }) {
  const qc = useQueryClient();
  const [name, setName] = useState(defaultName);
  const [description, setDescription] = useState('');
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try {
      await api.post(`/templates/${kind}`, { [kind === 'task' ? 'taskId' : 'listId']: sourceId, name: name.trim(), description: description.trim() || null });
      void qc.invalidateQueries({ queryKey: ['templates'] });
      toast.ok('Template saved');
      onClose();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not save the template');
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal open onClose={onClose} title={kind === 'task' ? 'Save task as template' : 'Save list as template'} width={460} footer={
      <>
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="primary" loading={busy} disabled={!name.trim()} onClick={() => void save()}>Save template</Button>
      </>
    }>
      <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); if (name.trim()) void save(); }}>
        <Field label="Template name"><Input autoFocus value={name} onChange={(e) => setName(e.target.value)} maxLength={200} /></Field>
        <Field label="Description" hint="(optional)"><Textarea rows={2} value={description} onChange={(e) => setDescription(e.target.value)} maxLength={2000} /></Field>
        <p className="text-xs text-muted">
          {kind === 'task'
            ? 'Includes subtasks, checklists, custom field values, assignees and tags. Dates are saved relative to today and shift when the template is used.'
            : 'Includes the list’s statuses, its own custom fields and its tasks (with subtasks, checklists and field values). Dates shift relative to when it’s used.'}
        </p>
      </form>
    </Modal>
  );
}
