import { db } from '../../db/client';
import { registerJob } from '../../lib/jobs';
import { registerTaskDetailExtension, registerTaskListExtension } from '../tasks/service';
import { fieldDto, fieldsForList, purgeOrphanFields, valuesForTasks } from './service';

/**
 * Task payload extensions:
 *   list + detail: `fields: Record<fieldId, value>` (formulas computed, relationship ids filtered by visibility)
 *   detail only:   `fieldDefinitions: CustomField[]` (fields applying to the task's list)
 */
export async function setup() {
  // custom_fields.scope_id has no FK (space/folder/list): clean up after deleted scopes
  registerJob('fields-orphans', 6 * 60 * 60_000, () => purgeOrphanFields(db));
  registerTaskListExtension('fields', async (tx, rows, access) => {
    const { result } = await valuesForTasks(tx, rows, access);
    return result;
  });
  registerTaskDetailExtension('fields', async (tx, task, access) => {
    const { result } = await valuesForTasks(tx, [task], access);
    return result.get(task.id) ?? {};
  });
  registerTaskDetailExtension('fieldDefinitions', async (tx, task) => (await fieldsForList(tx, task.listId)).map(fieldDto));
}
