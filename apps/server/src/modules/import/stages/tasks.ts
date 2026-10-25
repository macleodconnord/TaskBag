import { plainToRichText, type UpdateTaskInput } from '@app/shared';
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { Tx } from '../../../db/client';
import { checklistItems, checklists, statuses, tags, taskDependencies, taskFieldValues, taskLinks, tasks } from '../../../db/schema';
import { runTx } from '../../../lib/tx';
import { createTask, updateTask } from '../../tasks/service';
import type { CuChecklistItem, CuTask } from '../clickup/schemas';
import { checksum, type ImportContext } from '../context';
import { markdownToRichText } from '../markdown';
import { convertFieldValue, placementFor, type FieldPlan } from './fields';
import { groupFor, statusIdFor, type PlanList } from './hierarchy';

type StatusRow = typeof statuses.$inferSelect;
const iso = (ms: number | null | undefined) => (ms ? new Date(ms).toISOString() : null);

/** All tasks of a list (open + closed, subtasks; archived too when enabled), honouring delta `since`. */
export async function fetchListTasks(ctx: ImportContext, listId: string, since: Date | null) {
  const out = new Map<string, CuTask>();
  for (const archived of ctx.options.includeArchived ? [false, true] : [false]) {
    for (let page = 0; page < 10_000; page++) {
      const r = await ctx.api.getTasks(listId, page, { archived, updatedSince: since });
      for (const t of r.tasks) out.set(t.id, archived ? { ...t, archived: true } : t);
      if (r.lastPage || !r.tasks.length) break;
    }
  }
  return [...out.values()];
}

/** Parents before their subtasks, then ClickUp order. */
function orderTasks(list: CuTask[]) {
  const byId = new Map(list.map((t) => [t.id, t]));
  const depth = (t: CuTask) => {
    let d = 0;
    for (let p = t.parent; p && byId.has(p) && d < 50; p = byId.get(p)!.parent) d++;
    return d;
  };
  return [...list].sort((a, b) => depth(a) - depth(b) || Number(a.orderindex ?? 0) - Number(b.orderindex ?? 0));
}

interface NormItem { name: string; resolved: boolean; assigneeId: string | null; children: NormItem[] }

function normChecklists(ctx: ImportContext, t: CuTask) {
  return [...t.checklists].sort((a, b) => a.orderindex - b.orderindex).map((cl) => {
    const flat = new Map<string, CuChecklistItem>();
    const collect = (it: CuChecklistItem | string) => {
      if (typeof it === 'string') return;
      flat.set(it.id, it);
      it.children.forEach(collect);
    };
    cl.items.forEach(collect);
    const childIds = new Set<string>();
    for (const it of flat.values()) for (const c of it.children) childIds.add(typeof c === 'string' ? c : c.id);
    const kids = (id: string) => [...flat.values()].filter((x) => x.parent === id || flat.get(id)!.children.some((c) => (typeof c === 'string' ? c : c.id) === x.id));
    const build = (it: CuChecklistItem, seen: Set<string>): NormItem => ({
      name: it.name.slice(0, 500) || '(untitled)',
      resolved: it.resolved,
      assigneeId: it.assignee ? ctx.user(it.assignee, `checklist item ${it.id}`) : null,
      children: kids(it.id).filter((k) => !seen.has(k.id)).sort((a, b) => a.orderindex - b.orderindex).map((k) => build(k, new Set([...seen, k.id]))),
    });
    const roots = [...flat.values()].filter((x) => (!x.parent || !flat.has(x.parent)) && !childIds.has(x.id)).sort((a, b) => a.orderindex - b.orderindex);
    return { name: cl.name.slice(0, 200) || 'Checklist', items: roots.map((r) => build(r, new Set([r.id]))) };
  });
}

async function writeChecklists(tx: Tx, taskId: string, cls: ReturnType<typeof normChecklists>) {
  let n = 0;
  for (const [ci, cl] of cls.entries()) {
    const [row] = await tx.insert(checklists).values({ taskId, name: cl.name, position: ci }).returning({ id: checklists.id });
    const write = async (items: NormItem[], parentItemId: string | null) => {
      for (const [i, it] of items.entries()) {
        const [r] = await tx.insert(checklistItems).values({ checklistId: row.id, parentItemId, name: it.name, resolved: it.resolved, assigneeId: it.assigneeId, position: i })
          .returning({ id: checklistItems.id });
        n++;
        await write(it.children, r.id);
      }
    };
    await write(cl.items, null);
  }
  return n;
}

export interface TaskCaches {
  statuses: Map<string, StatusRow[]>;
  tags: Map<string, string>;
}

async function tagIdFor(ctx: ImportContext, tx: Tx, caches: TaskCaches, cuSpaceId: string, spaceId: string, tag: { name: string; tag_bg?: string | null }) {
  const name = tag.name.trim().slice(0, 50);
  const key = `${spaceId}:${name.toLowerCase()}`;
  const hit = caches.tags.get(key);
  if (hit) return hit;
  const ext = `${cuSpaceId}:${name.toLowerCase()}`;
  const color = tag.tag_bg && /^#[0-9a-f]{3,8}$/i.test(tag.tag_bg) ? tag.tag_bg : '#64748b';
  const [ins] = await tx.insert(tags).values({ spaceId, name, color }).onConflictDoNothing().returning({ id: tags.id });
  let id = ins?.id;
  if (ins) ctx.stat('tag', 'created');
  else {
    [{ id }] = await tx.select({ id: tags.id }).from(tags).where(and(eq(tags.spaceId, spaceId), sql`lower(${tags.name}) = ${name.toLowerCase()}`));
    ctx.stat('tag', 'unchanged');
  }
  await ctx.link(tx, 'tag', ext, id, null);
  caches.tags.set(key, id);
  return id;
}

/** Map one ClickUp task to our input shapes (shared by create/update/dry run). */
function mapTask(ctx: ImportContext, t: CuTask, pl: PlanList, fieldPlan: FieldPlan) {
  const where = `task ${t.id}`;
  const assigneeIds = [...new Set(t.assignees.map((u) => ctx.user(u, `${where} assignees`)).filter((u): u is string => !!u))];
  const description = t.markdown_description ? markdownToRichText(t.markdown_description) : t.text_content?.trim() ? plainToRichText(t.text_content) : null;
  const p = t.priority?.id ? Number(t.priority.id) : null;
  const priority = p && p >= 1 && p <= 4 ? p : null;
  const fieldValues: Array<{ ext: string; value: unknown }> = [];
  const rels: Array<{ field: string; targets: string[] }> = [];
  for (const cf of t.custom_fields) {
    if (cf.value === undefined || cf.value === null || cf.value === '') continue;
    const entry = fieldPlan[cf.id];
    if (!entry?.type) continue; // unsupported type: reported once in the fields stage
    const ext = placementFor(fieldPlan, cf.id, pl);
    if (!ext) {
      ctx.issue('warn', 'field', cf.id, `Value of custom field "${cf.name}" on task ${t.id}: the field's location was not found; value skipped`);
      ctx.stat('field_value', 'skipped');
      continue;
    }
    const v = convertFieldValue(entry.def, entry.type, cf.value, (id) => ctx.user({ id }, `${where} field "${cf.name}"`));
    if (v === undefined) continue;
    if (v && typeof v === 'object' && 'rel' in (v as object)) rels.push({ field: ext, targets: (v as { rel: string[] }).rel });
    else fieldValues.push({ ext, value: v });
  }
  const statusGroup = groupFor(t.status.type);
  const closedAt = statusGroup === 'done' || statusGroup === 'closed' ? (t.date_closed ?? t.date_done ?? t.date_updated) : null;
  const input = {
    name: (t.name.trim() || '(untitled)').slice(0, 500),
    description,
    priority,
    startAt: iso(t.start_date),
    dueAt: iso(t.due_date),
    dueHasTime: !!t.due_date_time,
    timeEstimateMin: t.time_estimate ? Math.round(t.time_estimate / 60_000) : null,
    assigneeIds,
  };
  const cls = normChecklists(ctx, t);
  const sum = checksum({
    input, status: t.status.status.toLowerCase(), tags: t.tags.map((x) => x.name.toLowerCase()).sort(), archived: t.archived,
    cls, fieldValues, list: pl.cu.id, parent: t.parent ?? null, closedAt, creator: ctx.author(t.creator?.id),
  });
  return { input, cls, fieldValues, rels, closedAt, sum };
}

async function writeFieldValues(ctx: ImportContext, tx: Tx, taskId: string, values: Array<{ ext: string; value: unknown }>, replace: boolean) {
  const rows: Array<typeof taskFieldValues.$inferInsert> = [];
  for (const v of values) {
    const fieldId = await ctx.idOf('field', v.ext);
    if (fieldId) rows.push({ taskId, fieldId, value: v.value, updatedBy: ctx.systemUserId });
  }
  if (replace) {
    const imported = [...(await ctx.allOf('field')).values()].map((x) => x.id);
    const keep = rows.map((r) => r.fieldId);
    const drop = imported.filter((id) => !keep.includes(id));
    if (drop.length) await tx.delete(taskFieldValues).where(and(eq(taskFieldValues.taskId, taskId), inArray(taskFieldValues.fieldId, drop)));
  }
  if (rows.length) {
    await tx.insert(taskFieldValues).values(rows)
      .onConflictDoUpdate({ target: [taskFieldValues.taskId, taskFieldValues.fieldId], set: { value: sql`excluded.value`, updatedBy: ctx.systemUserId } });
  }
  ctx.stat('field_value', 'created', rows.length);
}

/** Stage 4: tasks per list (resumable per list), subtasks, checklists, tags, assignees, field values. */
export async function runTasks(ctx: ImportContext, fieldPlan: FieldPlan) {
  const plan = ctx.plan!;
  const caches: TaskCaches = { statuses: new Map(), tags: new Map() };
  const pending = ctx.cursor.pending!;
  for (let li = ctx.cursor.pos!.tasksList ?? 0; li < plan.lists.length; li++) {
    const pl = plan.lists[li];
    const list = orderTasks(await fetchListTasks(ctx, pl.cu.id, ctx.since));
    const unchanged: string[] = [];
    for (const [i, t] of list.entries()) {
      ctx.stat('task', 'seen');
      try {
        const r = await importTask(ctx, t, pl, fieldPlan, caches);
        if (r === 'unchanged') unchanged.push(t.id);
        // relations are resolved after all tasks exist
        if (t.parent) pending.parents.push([t.id, t.parent]);
        for (const d of t.dependencies) pending.deps.push([d.task_id, d.depends_on]);
        for (const l of t.linked_tasks) pending.links.push([l.task_id, l.link_id]);
      } catch (err) {
        ctx.stat('task', 'failed');
        ctx.issue('error', 'task', t.id, `Task "${t.name}" failed: ${(err as Error).message}`);
      }
      if (ctx.dry) ctx.dryTaskIds.push(t.id);
      if (t.watchers?.length) ctx.dropped('watchers', t.watchers.length);
      if (t.time_spent) ctx.dropped('tasks_with_time_tracked');
      ctx.progress(li, plan.lists.length, `${pl.cu.name} (${i + 1}/${list.length})`);
      if (i % 20 === 19) await ctx.checkpoint();
    }
    await ctx.touch('task', unchanged);
    ctx.cursor.pos!.tasksList = li + 1;
    ctx.progress(li + 1, plan.lists.length, pl.cu.name);
    await ctx.checkpoint(true);
  }
}

async function importTask(ctx: ImportContext, t: CuTask, pl: PlanList, fieldPlan: FieldPlan, caches: TaskCaches): Promise<'created' | 'updated' | 'unchanged' | 'skipped'> {
  const m = mapTask(ctx, t, pl, fieldPlan);
  const rels = m.rels.map((r) => ({ task: t.id, ...r }));
  const mapped = await ctx.lookup('task', t.id);

  if (ctx.dry) {
    if (!pl.statuses.some((s) => s.status.toLowerCase() === t.status.status.toLowerCase())) {
      ctx.issue('warn', 'task', t.id, `Task "${t.name}": status "${t.status.status}" is not in its list's statuses; the first status of the same group is used`);
    }
    const kind = !mapped ? 'created' : mapped.checksum === m.sum ? 'unchanged' : 'updated';
    ctx.stat('task', kind);
    if (kind !== 'unchanged') {
      ctx.stat('checklist', 'created', m.cls.length);
      ctx.stat('field_value', 'created', m.fieldValues.length);
    }
    ctx.cursor.pending!.rels.push(...rels);
    return kind;
  }
  if (mapped && mapped.checksum === m.sum) {
    ctx.stat('task', 'unchanged');
    return 'unchanged';
  }

  const listId = await ctx.idOf('list', pl.cu.id);
  if (!listId) throw new Error('its list was not imported');
  const spaceId = (await ctx.idOf('space', pl.spaceExt))!;
  const creator = ctx.author(t.creator?.id);

  const result = await runTx(async (tx) => {
    const status = await statusIdFor(tx, listId, caches.statuses, t.status.status, t.status.type);
    if (!status.exact) ctx.issue('warn', 'task', t.id, `Task "${t.name}": status "${t.status.status}" not found in its list; mapped by group`);
    const tagIds: string[] = [];
    for (const tag of t.tags) tagIds.push(await tagIdFor(ctx, tx, caches, pl.spaceExt, spaceId, tag));
    const parentId = t.parent ? await ctx.idOf('task', t.parent) : null;
    const [parentRow] = parentId ? await tx.select({ listId: tasks.listId, deletedAt: tasks.deletedAt }).from(tasks).where(eq(tasks.id, parentId)) : [];
    const useParent = parentRow && !parentRow.deletedAt && parentRow.listId === listId ? parentId : null;

    const [existing] = mapped ? await tx.select().from(tasks).where(eq(tasks.id, mapped.id)) : [];
    if (existing?.deletedAt) {
      ctx.issue('info', 'task', t.id, `Task "${t.name}" was deleted here (${existing.key}); not re-imported`);
      ctx.stat('task', 'skipped');
      return 'skipped' as const;
    }
    let taskId: string;
    let kind: 'created' | 'updated';
    if (!existing) {
      const row = await createTask(tx, {
        listId, parentTaskId: useParent, ...m.input, statusId: status.id, tagIds,
      }, { actorId: creator, source: 'clickup', createdAt: t.date_created ? new Date(t.date_created) : undefined, silent: true });
      taskId = row.id;
      kind = 'created';
      ctx.stat('checklist_item', 'created', await writeChecklists(tx, taskId, m.cls));
      ctx.stat('checklist', 'created', m.cls.length);
      await writeFieldValues(ctx, tx, taskId, m.fieldValues, false);
    } else {
      const input: UpdateTaskInput = { ...m.input, statusId: status.id, tagIds, archived: t.archived };
      if (!existing.parentTaskId && existing.listId !== listId) input.listId = listId;
      if (!t.parent && existing.parentTaskId) input.parentTaskId = null;
      await updateTask(tx, existing, input, { actorId: ctx.systemUserId, silent: true });
      taskId = existing.id;
      kind = 'updated';
      await tx.delete(checklists).where(eq(checklists.taskId, taskId));
      ctx.stat('checklist_item', 'updated', await writeChecklists(tx, taskId, m.cls));
      ctx.stat('checklist', 'updated', m.cls.length);
      await writeFieldValues(ctx, tx, taskId, m.fieldValues, true);
    }
    // keep ClickUp's timestamps and archive state
    await tx.update(tasks).set({
      updatedAt: t.date_updated ? new Date(t.date_updated) : new Date(),
      completedAt: status.group === 'done' || status.group === 'closed' ? new Date(m.closedAt ?? Date.now()) : null,
      archivedAt: t.archived ? (existing?.archivedAt ?? new Date(t.date_updated ?? Date.now())) : null,
    }).where(eq(tasks.id, taskId));
    await ctx.link(tx, 'task', t.id, taskId, m.sum);
    return kind;
  });
  if (result !== 'skipped') {
    ctx.stat('task', result);
    ctx.cursor.pending!.rels.push(...rels);
  }
  return result;
}

/** Stage 5: subtask parents across lists/pages, dependencies, links and relationship field values. */
export async function runRelations(ctx: ImportContext) {
  const p = ctx.cursor.pending!;
  const total = p.parents.length + p.deps.length + p.links.length + p.rels.length;
  let done = 0;
  const tick = async () => {
    ctx.progress(++done, total);
    if (done % 50 === 0) await ctx.checkpoint();
  };

  for (const [childExt, parentExt] of p.parents) {
    const child = await ctx.idOf('task', childExt);
    const parent = await ctx.idOf('task', parentExt);
    if (!parent && !ctx.dry) {
      ctx.issue('warn', 'task', childExt, `Subtask ${childExt}: parent task ${parentExt} was not imported; kept as a top-level task`);
    } else if (child && parent) {
      try {
        await runTx(async (tx) => {
          const [row] = await tx.select().from(tasks).where(eq(tasks.id, child));
          if (row && row.parentTaskId !== parent) {
            await updateTask(tx, row, { parentTaskId: parent }, { actorId: ctx.systemUserId, silent: true });
            ctx.stat('subtask_parent', 'updated');
          }
        });
      } catch (err) {
        ctx.issue('warn', 'task', childExt, `Could not attach subtask to parent ${parentExt}: ${(err as Error).message}`);
      }
    } else if (ctx.dry) ctx.stat('subtask_parent', 'seen');
    await tick();
  }

  const pairs = async (list: Array<[string, string]>, entity: 'dependency' | 'link') => {
    const seen = new Set<string>();
    for (const [aExt, bExt] of list) {
      const key = entity === 'link' ? [aExt, bExt].sort().join('|') : `${aExt}|${bExt}`;
      if (seen.has(key) || aExt === bExt) { await tick(); continue; }
      seen.add(key);
      ctx.stat(entity, 'seen');
      const a = await ctx.idOf('task', aExt);
      const b = await ctx.idOf('task', bExt);
      if (ctx.dry) { await tick(); continue; }
      if (!a || !b) {
        ctx.stat(entity, 'skipped');
        ctx.issue('warn', entity, `${aExt}->${bExt}`, `${entity === 'link' ? 'Link' : 'Dependency'} between ${aExt} and ${bExt}: one of the tasks was not imported`);
      } else if (entity === 'dependency') {
        const r = await runTx((tx) => tx.insert(taskDependencies).values({ taskId: a, dependsOnTaskId: b }).onConflictDoNothing().returning());
        ctx.stat(entity, r.length ? 'created' : 'unchanged');
      } else {
        const [x, y] = [a, b].sort();
        const r = await runTx((tx) => tx.insert(taskLinks).values({ taskAId: x, taskBId: y, createdBy: ctx.systemUserId }).onConflictDoNothing().returning());
        ctx.stat(entity, r.length ? 'created' : 'unchanged');
      }
      await tick();
    }
  };
  await pairs(p.deps, 'dependency');
  await pairs(p.links, 'link');

  for (const r of p.rels) {
    ctx.stat('field_value', 'seen');
    if (!ctx.dry) {
      const taskId = await ctx.idOf('task', r.task);
      const fieldId = await ctx.idOf('field', r.field);
      const targets = (await Promise.all(r.targets.map((x) => ctx.idOf('task', x)))).filter((x): x is string => !!x);
      if (targets.length < r.targets.length) ctx.issue('warn', 'field_value', r.task, `Relationship field on task ${r.task}: ${r.targets.length - targets.length} related task(s) were not imported`);
      if (taskId && fieldId) {
        await runTx((tx) => tx.insert(taskFieldValues).values({ taskId, fieldId, value: targets, updatedBy: ctx.systemUserId })
          .onConflictDoUpdate({ target: [taskFieldValues.taskId, taskFieldValues.fieldId], set: { value: targets } }));
        ctx.stat('field_value', 'created');
      }
    }
    await tick();
  }
  ctx.cursor.pending = { parents: [], deps: [], links: [], rels: [] };
}
