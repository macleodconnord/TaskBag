import type { FieldType } from '@app/shared';
import { and, eq, inArray } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { db } from '../../db/client';
import { customFields, taskFieldValues } from '../../db/schema';
import { NotFound, Validation } from '../../lib/errors';
import { emit } from '../../lib/events';
import { auth, parse, type Req } from '../../lib/http';
import { runTx } from '../../lib/tx';
import { findTask } from '../tasks/service';
import {
  checkFormula, createFieldSchema, fieldAppliesToList, fieldDto, fieldsForScope, formulaNamesForScope, nextFieldPosition,
  normalizeConfig, normalizeValue, orderedFields, updateFieldSchema, writeValue,
} from './service';

const scopeQuery = z.object({
  scopeType: z.enum(['space', 'folder', 'list', 'everything']),
  scopeId: z.string().uuid().optional(),
  /** only fields defined exactly at this scope (field manager) */
  exact: z.enum(['true', 'false']).optional(),
  includeArchived: z.enum(['true', 'false']).optional(),
});

/** /api/fields — custom field definitions (V-03) and values (V-04); formulas (V-11) are computed on read. */
export default async function fieldsRoutes(app: FastifyInstance) {
  async function loadField(id: string) {
    const [f] = await db.select().from(customFields).where(eq(customFields.id, id));
    if (!f) throw new NotFound('Field not found');
    return f;
  }

  // ── definitions ──
  app.get('/', async (req) => {
    const { access } = auth(req);
    const q = parse(scopeQuery, req.query);
    if (q.scopeType === 'everything') {
      if (access.isGuest) return [];
    } else {
      if (!q.scopeId) throw new Validation('scopeId is required');
      await access.require('view', q.scopeType, q.scopeId);
    }
    const rows = await fieldsForScope(db, access, q.scopeType, q.scopeId, { exact: q.exact === 'true', includeArchived: q.includeArchived === 'true' });
    return rows.map(fieldDto);
  });

  app.get<{ Params: { id: string } }>('/:id', async (req) => {
    const { access } = auth(req);
    const f = await loadField(req.params.id);
    await access.require('view', f.scopeType, f.scopeId);
    return fieldDto(f);
  });

  app.post('/', async (req) => {
    const { access } = auth(req);
    const input = parse(createFieldSchema, req.body);
    await access.require('manage', input.scopeType, input.scopeId);
    const config = normalizeConfig(input.type, input.config);
    return runTx(async (tx) => {
      if (input.type === 'formula') checkFormula(String(config.expression), await formulaNamesForScope(tx, input.scopeType, input.scopeId));
      if (input.type === 'relationship' && config.targetListId) await access.require('view', 'list', String(config.targetListId), tx);
      const [f] = await tx.insert(customFields).values({
        name: input.name, type: input.type, config, scopeType: input.scopeType, scopeId: input.scopeId,
        required: input.required ?? false, position: await nextFieldPosition(tx, input.scopeType, input.scopeId),
      }).returning();
      return fieldDto(f);
    });
  });

  app.patch<{ Params: { id: string } }>('/:id', async (req) => {
    const { access } = auth(req);
    const input = parse(updateFieldSchema, req.body);
    const f = await loadField(req.params.id);
    await access.require('manage', f.scopeType, f.scopeId);
    return runTx(async (tx) => {
      const set: Partial<typeof customFields.$inferInsert> = {};
      if (input.name !== undefined) set.name = input.name;
      if (input.required !== undefined) set.required = input.required;
      if (input.archived !== undefined) set.archivedAt = input.archived ? (f.archivedAt ?? new Date()) : null;
      if (input.config !== undefined) {
        const type = f.type as FieldType;
        const config = normalizeConfig(type, input.config);
        if (type === 'formula') checkFormula(String(config.expression), await formulaNamesForScope(tx, f.scopeType, f.scopeId, f.id));
        if (type === 'relationship' && config.targetListId && config.targetListId !== f.config.targetListId) await access.require('view', 'list', String(config.targetListId), tx);
        if (type === 'dropdown' || type === 'labels') {
          // values pointing at removed options are cleared
          const keep = new Set((config.options as Array<{ id: string }>).map((o) => o.id));
          const removed = ((f.config.options as Array<{ id: string }> | undefined) ?? []).filter((o) => !keep.has(o.id)).map((o) => o.id);
          if (removed.length) {
            const vals = await tx.select().from(taskFieldValues).where(eq(taskFieldValues.fieldId, f.id));
            for (const v of vals) {
              const next = Array.isArray(v.value) ? v.value.filter((x) => !removed.includes(String(x))) : removed.includes(String(v.value)) ? null : v.value;
              if (JSON.stringify(next) === JSON.stringify(v.value)) continue;
              await writeValue(tx, v.taskId, f.id, next === null || (Array.isArray(next) && !next.length) ? null : next, null);
            }
          }
        }
        set.config = config;
      }
      const [u] = Object.keys(set).length ? await tx.update(customFields).set(set).where(eq(customFields.id, f.id)).returning() : [f];
      return fieldDto(u);
    });
  });

  app.delete<{ Params: { id: string } }>('/:id', async (req) => {
    const { access } = auth(req);
    const f = await loadField(req.params.id);
    await access.require('manage', f.scopeType, f.scopeId);
    await db.delete(customFields).where(eq(customFields.id, f.id));
    return { ok: true };
  });

  app.post('/reorder', async (req) => {
    const { access } = auth(req);
    const input = parse(z.object({ scopeType: z.enum(['space', 'folder', 'list']), scopeId: z.string().uuid(), ids: z.array(z.string().uuid()).max(500) }), req.body);
    await access.require('manage', input.scopeType, input.scopeId);
    await runTx(async (tx) => {
      const current = await orderedFields(tx, input.scopeType, input.scopeId);
      const known = new Set(current.map((f) => f.id));
      const order = [...input.ids.filter((id) => known.has(id)), ...current.map((f) => f.id).filter((id) => !input.ids.includes(id))];
      for (const [i, id] of order.entries()) await tx.update(customFields).set({ position: i }).where(eq(customFields.id, id));
    });
    return { ok: true };
  });

  // ── values ──
  const putValue = async (req: Req, taskRef: string, fieldId: string, raw: unknown) => {
    const { user, access } = auth(req);
    const task = await findTask(db, taskRef);
    if (!task) throw new NotFound('Task not found');
    await access.require('edit', 'task', task.id);
    const field = await loadField(fieldId);
    if (field.archivedAt || !(await fieldAppliesToList(db, field, task.listId))) throw new Validation('That field does not apply to this task');
    return runTx(async (tx) => {
      const value = await normalizeValue(tx, field, raw, access);
      const [prev] = await tx.select({ v: taskFieldValues.value }).from(taskFieldValues)
        .where(and(eq(taskFieldValues.taskId, task.id), eq(taskFieldValues.fieldId, field.id)));
      await writeValue(tx, task.id, field.id, value, user.id);
      if (JSON.stringify(prev?.v ?? null) !== JSON.stringify(value)) {
        emit('task.updated', { taskId: task.id, actorId: user.id, changes: { [`cf:${field.id}`]: { from: prev?.v ?? null, to: value } } });
      }
      return { taskId: task.id, fieldId: field.id, value };
    });
  };

  app.put<{ Params: { taskId: string; fieldId: string } }>('/values/:taskId/:fieldId', async (req) => {
    const { value } = parse(z.object({ value: z.unknown() }), req.body ?? {});
    return putValue(req, req.params.taskId, parse(z.string().uuid(), req.params.fieldId), value);
  });

  app.delete<{ Params: { taskId: string; fieldId: string } }>('/values/:taskId/:fieldId', async (req) =>
    putValue(req, req.params.taskId, parse(z.string().uuid(), req.params.fieldId), null));

  /** Bulk: values for a set of fields on one task, e.g. { values: { fieldId: value } } (used by templates / forms). */
  app.put<{ Params: { taskId: string } }>('/values/:taskId', async (req) => {
    const { values } = parse(z.object({ values: z.record(z.string().uuid(), z.unknown()) }), req.body);
    const out: Record<string, unknown> = {};
    const ids = Object.keys(values);
    if (ids.length) {
      const known = await db.select({ id: customFields.id }).from(customFields).where(inArray(customFields.id, ids));
      if (known.length !== ids.length) throw new NotFound('Field not found');
    }
    for (const id of ids) out[id] = (await putValue(req, req.params.taskId, id, values[id])).value;
    return { values: out };
  });
}
