import { useState } from 'react';
import type { ViewConfig, ViewType } from '@app/shared';
import type { CustomField } from '@/features/fields/public';
import type { ScopeType } from './api';

export const VIEW_LABELS: Record<ViewType, string> = { list: 'List', board: 'Board', table: 'Table', calendar: 'Calendar', gantt: 'Gantt' };

export interface ColumnDef { key: string; label: string; width: number; field?: CustomField }

export const BUILTIN_COLUMNS: ColumnDef[] = [
  { key: 'status', label: 'Status', width: 140 },
  { key: 'assignees', label: 'Assignees', width: 120 },
  { key: 'due_at', label: 'Due date', width: 120 },
  { key: 'start_at', label: 'Start date', width: 120 },
  { key: 'priority', label: 'Priority', width: 110 },
  { key: 'tags', label: 'Tags', width: 180 },
  { key: 'list', label: 'List', width: 150 },
  { key: 'key', label: 'ID', width: 90 },
  { key: 'created_at', label: 'Created', width: 110 },
  { key: 'updated_at', label: 'Updated', width: 110 },
];

export const NAME_WIDTH = 320;
export const MIN_COL = 60;

export function defaultColumns(scope: ScopeType): string[] {
  return ['status', 'assignees', 'due_at', 'priority', 'tags', ...(scope === 'list' ? [] : ['list'])];
}

/** Every column the table can show (built-ins + custom fields), keyed. */
export function allColumns(fields: CustomField[]): ColumnDef[] {
  return [...BUILTIN_COLUMNS, ...fields.map((f) => ({ key: `cf:${f.id}`, label: f.name, width: 150, field: f }))];
}

/** Visible columns in order; unknown keys (e.g. a deleted field) are dropped. */
export function visibleColumns(config: ViewConfig, scope: ScopeType, fields: CustomField[]): ColumnDef[] {
  const all = allColumns(fields);
  const keys = config.columns.length ? config.columns : defaultColumns(scope);
  return keys.map((k) => all.find((c) => c.key === k)).filter((c): c is ColumnDef => !!c)
    .map((c) => ({ ...c, width: config.columnWidths[c.key] ?? c.width }));
}

export const SORT_FIELDS: Array<{ key: string; label: string }> = [
  { key: 'name', label: 'Task name' },
  { key: 'status', label: 'Status' },
  { key: 'priority', label: 'Priority' },
  { key: 'due_at', label: 'Due date' },
  { key: 'start_at', label: 'Start date' },
  { key: 'created_at', label: 'Date created' },
  { key: 'updated_at', label: 'Date updated' },
  { key: 'key', label: 'Task ID' },
];

export function groupOptions(scope: ScopeType, fields: CustomField[]) {
  return [
    { value: 'status', label: 'Status' },
    { value: 'assignee', label: 'Assignee' },
    { value: 'priority', label: 'Priority' },
    { value: 'due', label: 'Due date' },
    { value: 'tag', label: 'Tag' },
    ...(scope !== 'list' ? [{ value: 'list', label: 'List' }] : []),
    ...fields.filter((f) => ['dropdown', 'labels', 'checkbox', 'user'].includes(f.type)).map((f) => ({ value: `cf:${f.id}`, label: f.name })),
    { value: 'none', label: 'None' },
  ];
}

/** Defaults for a fresh (built-in or newly created) view of a type. */
export function initialConfig(type: ViewType, base: ViewConfig): ViewConfig {
  if (type === 'table') return { ...base, groupBy: 'none' };
  if (type === 'gantt') return { ...base, groupBy: 'none', sort: base.sort.length ? base.sort : [{ field: 'start_at', dir: 'asc' }] };
  return base;
}

/** Per-viewer UI prefs that aren't part of ViewConfig (calendar mode, gantt zoom), kept in localStorage. */
export function usePref<T extends string>(key: string, fallback: T): [T, (v: T) => void] {
  const [value, setValue] = useState<T>(() => {
    try { return (localStorage.getItem(`views:${key}`) as T | null) ?? fallback; } catch { return fallback; }
  });
  return [value, (v: T) => {
    setValue(v);
    try { localStorage.setItem(`views:${key}`, v); } catch { /* storage unavailable */ }
  }];
}
