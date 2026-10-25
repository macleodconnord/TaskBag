import { registerListDetailExtension } from '../hierarchy/routes';
import { registerTaskDetailExtension, registerTaskListExtension } from '../tasks/service';
import { linkedFromTask, linkedListForTask, linkProgressForTasks } from './service';

/**
 * Task detail `linkedList` (rollup + preview, or `{ hidden: true }`, or null),
 * task list `linkedList` (progress for chips, linked tasks only),
 * list detail `linkedFromTask` (breadcrumb to the owning task, if visible).
 */
export async function setup() {
  registerTaskDetailExtension('linkedList', (tx, task, access) => linkedListForTask(tx, task, access));
  registerTaskListExtension('linkedList', (tx, rows, access) => linkProgressForTasks(tx, rows, access));
  registerListDetailExtension(async (tx, list, access) => ({ linkedFromTask: await linkedFromTask(tx, list.id, access) }));
}
