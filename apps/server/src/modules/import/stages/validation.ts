import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { db } from '../../../db/client';
import { attachments, externalIds, taskFieldValues, tasks } from '../../../db/schema';
import { storagePath } from '../../attachments/routes';
import type { CuTask } from '../clickup/schemas';
import { SOURCE, type ImportContext, type ValidationResult } from '../context';
import { convertFieldValue, placementFor, type FieldPlan } from './fields';
import { fetchListTasks } from './tasks';

const FIELD_SAMPLES = 40;
const ATTACHMENT_SAMPLES = 5;

async function sha256Of(stream: NodeJS.ReadableStream) {
  const h = createHash('sha256');
  for await (const chunk of stream) h.update(chunk as Buffer);
  return h.digest('hex');
}

const norm = (v: unknown) => JSON.stringify(Array.isArray(v) ? [...v].map(String).sort() : v);

/** Stage 10 (M-12): per-list task counts, sampled field values and attachment checksums vs ClickUp. */
export async function runValidation(ctx: ImportContext, fieldPlan: FieldPlan): Promise<ValidationResult> {
  const plan = ctx.plan!;
  const result: ValidationResult = { at: new Date().toISOString(), lists: [], fields: { checked: 0, mismatches: [] }, attachments: { checked: 0, mismatches: [] }, ok: true };
  const imported = db.select({ id: externalIds.internalId }).from(externalIds).where(and(eq(externalIds.source, SOURCE), eq(externalIds.entity, 'task')));
  const samples: Array<{ t: CuTask; listIdx: number }> = [];
  let valuesSeen = 0;

  for (const [i, pl] of plan.lists.entries()) {
    const listId = await ctx.idOf('list', pl.cu.id);
    const cu = await fetchListTasks(ctx, pl.cu.id, null);
    let ours = 0;
    if (listId) {
      const [r] = await db.select({ n: sql<number>`count(*)::int` }).from(tasks)
        .where(and(eq(tasks.listId, listId), isNull(tasks.deletedAt), inArray(tasks.id, imported)));
      ours = r.n;
    }
    const ok = ours === cu.length;
    result.lists.push({ listExt: pl.cu.id, name: pl.cu.name, clickup: cu.length, ours, ok });
    if (!ok) ctx.issue('warn', 'validation', pl.cu.id, `List "${pl.cu.name}": ClickUp has ${cu.length} tasks, imported ${ours}`);
    for (const t of cu) {
      if (t.custom_fields.some((f) => f.value !== undefined && f.value !== null && f.value !== '')) {
        valuesSeen++;
        // reservoir sample
        if (samples.length < FIELD_SAMPLES) samples.push({ t, listIdx: i });
        else {
          const j = Math.floor(Math.random() * valuesSeen);
          if (j < FIELD_SAMPLES) samples[j] = { t, listIdx: i };
        }
      }
    }
    ctx.progress(i + 1, plan.lists.length + 2, `counts: ${pl.cu.name}`);
    await ctx.checkpoint();
  }

  for (const { t, listIdx } of samples) {
    const taskId = await ctx.idOf('task', t.id);
    if (!taskId) continue;
    for (const f of t.custom_fields) {
      const e = fieldPlan[f.id];
      if (!e?.type || f.value === undefined || f.value === null || f.value === '') continue;
      const ext = placementFor(fieldPlan, f.id, plan.lists[listIdx]);
      const fieldId = ext ? await ctx.idOf('field', ext) : null;
      if (!fieldId) continue;
      let expected = convertFieldValue(e.def, e.type, f.value, (id) => ctx.users.get(id) ?? null);
      if (expected && typeof expected === 'object' && 'rel' in (expected as object)) {
        expected = (await Promise.all((expected as { rel: string[] }).rel.map((x) => ctx.idOf('task', x)))).filter(Boolean);
      }
      if (expected === undefined) continue;
      const [row] = await db.select({ v: taskFieldValues.value }).from(taskFieldValues).where(and(eq(taskFieldValues.taskId, taskId), eq(taskFieldValues.fieldId, fieldId)));
      result.fields.checked++;
      if (norm(row?.v ?? null) !== norm(expected)) {
        result.fields.mismatches.push({ task: t.id, field: f.name, expected, actual: row?.v ?? null });
        ctx.issue('warn', 'validation', t.id, `Field "${f.name}" on task ${t.id}: expected ${norm(expected)}, found ${norm(row?.v ?? null)}`);
      }
    }
  }
  ctx.progress(plan.lists.length + 1, plan.lists.length + 2, 'attachments');
  await ctx.checkpoint();

  const sampled = await db.select({ ext: externalIds.externalId, id: externalIds.internalId, sum: externalIds.checksum }).from(externalIds)
    .where(and(eq(externalIds.source, SOURCE), eq(externalIds.entity, 'attachment'))).orderBy(sql`random()`).limit(ATTACHMENT_SAMPLES);
  for (const s of sampled) {
    const [a] = await db.select().from(attachments).where(eq(attachments.id, s.id));
    if (!a) continue;
    result.attachments.checked++;
    const problems: string[] = [];
    try {
      const disk = await sha256Of(createReadStream(storagePath(a.storageKey)));
      if (disk !== a.sha256) problems.push('stored file does not match its recorded sha256');
    } catch {
      problems.push('stored file is missing');
    }
    if (s.sum && s.sum !== a.sha256) problems.push('sha256 differs from the import record');
    // re-download from ClickUp and compare
    const [link] = a.taskId ? await db.select({ ext: externalIds.externalId }).from(externalIds)
      .where(and(eq(externalIds.source, SOURCE), eq(externalIds.entity, 'task'), eq(externalIds.internalId, a.taskId))) : [];
    if (link && !s.ext.startsWith('url:')) {
      try {
        const t = await ctx.api.getTask(link.ext);
        const cu = t.attachments?.find((x) => x.id === s.ext);
        if (cu) {
          const remote = await sha256Of((await ctx.api.download(cu.url)).stream);
          if (remote !== a.sha256) problems.push('ClickUp file checksum differs');
        }
      } catch (err) {
        problems.push(`could not re-download from ClickUp: ${(err as Error).message}`);
      }
    }
    if (problems.length) {
      result.attachments.mismatches.push({ attachment: s.ext, filename: a.filename, problem: problems.join('; ') });
      ctx.issue('warn', 'validation', s.ext, `Attachment "${a.filename}": ${problems.join('; ')}`);
    }
  }
  result.ok = result.lists.every((l) => l.ok) && !result.fields.mismatches.length && !result.attachments.mismatches.length;
  ctx.cursor.validation = result;
  ctx.progress(plan.lists.length + 2, plan.lists.length + 2, 'done');
  return result;
}
