import type { FieldType } from '@app/shared';
import { eq } from 'drizzle-orm';
import { customFields } from '../../../db/schema';
import { runTx } from '../../../lib/tx';
import type { CuLocation } from '../clickup/client';
import type { CuField } from '../clickup/schemas';
import { checksum, type ImportContext } from '../context';
import type { PlanList } from './hierarchy';

/** ClickUp field type → ours (null = not supported, reported). */
export const FIELD_TYPE_MAP: Record<string, FieldType | null> = {
  text: 'text', short_text: 'text', number: 'number', currency: 'currency', drop_down: 'dropdown', labels: 'labels',
  date: 'date', checkbox: 'checkbox', users: 'user', url: 'url', email: 'email', phone: 'phone', emoji: 'rating',
  progress: 'progress', manual_progress: 'progress', automatic_progress: 'progress', tasks: 'relationship', list_relationship: 'relationship',
  formula: null, location: null, attachment: null, votes: null, signature: null, button: null, rollup: null,
};

/** a field definition without a task value */
export type FieldDef = Pick<CuField, 'id' | 'name' | 'type' | 'type_config' | 'required' | 'hide_from_guests'>;

export type ScopeType = 'space' | 'folder' | 'list';
export interface FieldPlanEntry {
  def: FieldDef;
  type: FieldType | null;
  placements: Array<{ scopeType: ScopeType; cuScopeId: string }>;
}
export type FieldPlan = Record<string, FieldPlanEntry>;

export const placementExt = (fieldId: string, p: { scopeType: ScopeType; cuScopeId: string }) => `${fieldId}@${p.scopeType}:${p.cuScopeId}`;

/** The placement (field copy) that applies to a task in `list`: list → folder → space. */
export function placementFor(plan: FieldPlan, fieldId: string, list: PlanList): string | null {
  const e = plan[fieldId];
  if (!e || !e.type) return null;
  const order: Array<[ScopeType, string | null]> = [['list', list.cu.id], ['folder', list.folderExt], ['space', list.spaceExt]];
  for (const [t, id] of order) {
    if (!id) continue;
    const p = e.placements.find((x) => x.scopeType === t && x.cuScopeId === id);
    if (p) return placementExt(fieldId, p);
  }
  return null;
}

function configFor(f: FieldDef, type: FieldType): Record<string, unknown> {
  const tc = f.type_config as Record<string, unknown>;
  const opts = Array.isArray(tc.options) ? (tc.options as Array<Record<string, unknown>>) : [];
  switch (type) {
    case 'dropdown':
      return { options: [...opts].sort((a, b) => Number(a.orderindex ?? 0) - Number(b.orderindex ?? 0)).map((o) => ({ id: String(o.id), name: String(o.name ?? o.label ?? ''), color: typeof o.color === 'string' ? o.color : '#94a3b8' })) };
    case 'labels':
      return { options: opts.map((o) => ({ id: String(o.id), name: String(o.label ?? o.name ?? ''), color: typeof o.color === 'string' ? o.color : '#94a3b8' })) };
    case 'currency':
      return { currency: typeof tc.currency_type === 'string' ? tc.currency_type : 'USD', precision: typeof tc.precision === 'number' ? tc.precision : 2 };
    case 'number':
      return typeof tc.precision === 'number' ? { precision: tc.precision } : {};
    case 'rating':
      return { max: typeof tc.count === 'number' ? tc.count : 5 };
    default:
      return {};
  }
}

/**
 * Convert a ClickUp custom field value to our value shape (see tasks/filter.ts).
 * Returns undefined for "no value"; relationship values come back as `{ rel: clickupTaskIds }`.
 */
export function convertFieldValue(def: FieldDef, type: FieldType, value: unknown, mapUser: (id: string) => string | null): unknown | { rel: string[] } | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const tc = def.type_config as Record<string, unknown>;
  const opts = Array.isArray(tc.options) ? (tc.options as Array<Record<string, unknown>>) : [];
  switch (type) {
    case 'text': case 'url': case 'email': case 'phone':
      return String(value);
    case 'number': case 'currency': case 'rating': {
      const n = Number(value);
      return Number.isFinite(n) ? n : undefined;
    }
    case 'progress': {
      const p = typeof value === 'object' ? Number((value as Record<string, unknown>).percent_completed ?? (value as Record<string, unknown>).current) : Number(value);
      return Number.isFinite(p) ? p : undefined;
    }
    case 'dropdown': {
      // older API: orderindex number; newer: option uuid
      const o = opts.find((x) => String(x.id) === String(value)) ?? opts.find((x) => Number(x.orderindex) === Number(value));
      return o ? String(o.id) : undefined;
    }
    case 'labels': {
      const ids = (Array.isArray(value) ? value : [value]).map(String).filter((v) => opts.some((o) => String(o.id) === v));
      return ids.length ? ids : undefined;
    }
    case 'date': {
      const n = Number(value);
      return Number.isFinite(n) && n > 0 ? new Date(n).toISOString() : undefined;
    }
    case 'checkbox':
      return value === true || value === 'true' || value === 1 || value === '1';
    case 'user': {
      const ids = (Array.isArray(value) ? value : [value])
        .map((u) => (typeof u === 'object' && u ? String((u as Record<string, unknown>).id) : String(u)))
        .map(mapUser).filter((u): u is string => !!u);
      return ids.length ? ids : undefined;
    }
    case 'relationship': {
      const ids = (Array.isArray(value) ? value : [value]).map((t) => (typeof t === 'object' && t ? String((t as Record<string, unknown>).id) : String(t)));
      return ids.length ? { rel: ids } : undefined;
    }
    default:
      return undefined;
  }
}

/** Discover definitions at workspace/space/folder/list level and decide where each lives here. API only. */
export async function fetchFieldPlan(ctx: ImportContext): Promise<FieldPlan> {
  const plan = ctx.plan!;
  const defs = new Map<string, FieldDef>();
  const seenAt = new Map<string, Array<{ type: CuLocation['type']; id: string }>>();
  const note = (fs: CuField[], loc: CuLocation) => {
    for (const x of fs) {
      const f: FieldDef = { id: x.id, name: x.name, type: x.type, type_config: x.type_config, required: x.required, hide_from_guests: x.hide_from_guests };
      defs.set(f.id, f);
      seenAt.set(f.id, [...(seenAt.get(f.id) ?? []), { type: loc.type, id: loc.id }]);
    }
  };
  const locs: CuLocation[] = [
    { type: 'team', id: ctx.api.teamId },
    ...plan.spaces.map((s) => ({ type: 'space' as const, id: s.id })),
    ...plan.folders.map((f) => ({ type: 'folder' as const, id: f.cu.id })),
    ...plan.lists.map((l) => ({ type: 'list' as const, id: l.cu.id })),
  ];
  for (const [i, loc] of locs.entries()) {
    note(await ctx.api.getFields(loc), loc);
    ctx.progress(i + 1, locs.length, `definitions (${loc.type})`);
    await ctx.checkpoint();
  }

  const out: FieldPlan = {};
  for (const [id, def] of defs) {
    const at = seenAt.get(id)!;
    const type = FIELD_TYPE_MAP[def.type] ?? null;
    let placements: FieldPlanEntry['placements'] = [];
    if (at.some((a) => a.type === 'team')) {
      placements = plan.spaces.map((s) => ({ scopeType: 'space', cuScopeId: s.id }));
    } else if (at.some((a) => a.type === 'space')) {
      placements = at.filter((a) => a.type === 'space').map((a) => ({ scopeType: 'space', cuScopeId: a.id }));
    } else if (at.some((a) => a.type === 'folder')) {
      placements = at.filter((a) => a.type === 'folder').map((a) => ({ scopeType: 'folder', cuScopeId: a.id }));
    } else {
      // only seen through lists: lift to the folder/space when every list there has it
      const listIds = new Set(at.map((a) => a.id));
      const lists = plan.lists.filter((l) => listIds.has(l.cu.id));
      const covered = new Set<string>();
      for (const s of plan.spaces) {
        const inSpace = plan.lists.filter((l) => l.spaceExt === s.id);
        if (inSpace.length > 1 && inSpace.every((l) => listIds.has(l.cu.id))) {
          placements.push({ scopeType: 'space', cuScopeId: s.id });
          inSpace.forEach((l) => covered.add(l.cu.id));
        }
      }
      for (const f of plan.folders) {
        const inFolder = plan.lists.filter((l) => l.folderExt === f.cu.id && !covered.has(l.cu.id));
        if (inFolder.length > 1 && inFolder.every((l) => listIds.has(l.cu.id))) {
          placements.push({ scopeType: 'folder', cuScopeId: f.cu.id });
          inFolder.forEach((l) => covered.add(l.cu.id));
        }
      }
      for (const l of lists) if (!covered.has(l.cu.id)) placements.push({ scopeType: 'list', cuScopeId: l.cu.id });
    }
    out[id] = { def, type, placements };
  }
  return out;
}

/** Stage 3: custom field definitions → custom_fields (one row per placement). */
export async function runFields(ctx: ImportContext, fieldPlan: FieldPlan) {
  const entries = Object.values(fieldPlan);
  let done = 0;
  for (const e of entries) {
    const f = e.def;
    if (!e.type) {
      ctx.stat('field', 'skipped');
      ctx.issue('warn', 'field', f.id, `Custom field "${f.name}" has unsupported type "${f.type}"; definition and values are not imported`);
      continue;
    }
    if (f.type === 'automatic_progress' || (f.type === 'progress' && (f.type_config as { method?: { type?: string } }).method?.type === 'automatic')) {
      ctx.issue('info', 'field', f.id, `Custom field "${f.name}" is automatic progress in ClickUp; imported as a manual progress value (snapshot)`);
    }
    if (f.type === 'list_relationship') {
      ctx.issue('info', 'field', f.id, `Custom field "${f.name}" (list relationship) is imported as a plain task relationship`);
    }
    if (e.placements.length > 1) {
      ctx.issue('info', 'field', f.id, `Custom field "${f.name}" is used in ${e.placements.length} locations; created once per location`);
    }
    if (f.hide_from_guests) ctx.issue('info', 'field', f.id, `Custom field "${f.name}" is hidden from guests in ClickUp; field-level guest visibility is not supported`);
    const config = configFor(f, e.type);
    for (const [i, p] of e.placements.entries()) {
      ctx.stat('field', 'seen');
      const ext = placementExt(f.id, p);
      const want = { name: f.name.slice(0, 100), type: e.type, config, required: !!f.required };
      const sum = checksum(want);
      const mapped = await ctx.lookup('field', ext);
      if (ctx.dry) {
        ctx.stat('field', !mapped ? 'created' : mapped.checksum === sum ? 'unchanged' : 'updated');
        continue;
      }
      if (mapped && mapped.checksum === sum) {
        ctx.stat('field', 'unchanged');
        await ctx.touch('field', [ext]);
        continue;
      }
      const scopeId = await ctx.idOf(p.scopeType, p.cuScopeId);
      if (!scopeId) {
        ctx.issue('warn', 'field', f.id, `Custom field "${f.name}": its ${p.scopeType} was not imported`);
        continue;
      }
      await runTx(async (tx) => {
        let id = mapped?.id;
        const [row] = id ? await tx.select({ id: customFields.id }).from(customFields).where(eq(customFields.id, id)) : [];
        if (row) {
          await tx.update(customFields).set({ ...want }).where(eq(customFields.id, row.id));
          ctx.stat('field', 'updated');
        } else {
          [{ id }] = await tx.insert(customFields).values({ ...want, scopeType: p.scopeType, scopeId, position: i }).returning({ id: customFields.id });
          ctx.stat('field', 'created');
        }
        await ctx.link(tx, 'field', ext, id!, sum);
      });
    }
    ctx.progress(++done, entries.length, f.name);
    await ctx.checkpoint();
  }
}
