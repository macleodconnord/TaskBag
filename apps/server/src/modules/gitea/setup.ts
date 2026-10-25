import { desc, eq } from 'drizzle-orm';
import { giteaLinks } from '../../db/schema';
import { registerTaskDetailExtension } from '../tasks/service';
import { giteaSettings } from './client';
import { branchNameFor } from './service';

/** Gitea: the task detail `development` key (links + what the panel needs to create branches/issues). */
export async function setup() {
  registerTaskDetailExtension('development', async (tx, task, access) => {
    const links = await tx.select().from(giteaLinks).where(eq(giteaLinks.taskId, task.id)).orderBy(desc(giteaLinks.occurredAt)).limit(200);
    const s = await giteaSettings();
    const configured = s.enabled && !!s.baseUrl && !!s.apiToken;
    if (!links.length && !configured) return null;
    const level = await access.levelOfScope(task.aclScopeId);
    return {
      links: links.map(({ taskId: _t, ...l }) => l),
      gitea: {
        enabled: configured,
        repos: configured ? s.repos : [],
        defaultBranchName: branchNameFor(s.branchTemplate, task),
        canCreate: configured && (level === 'edit' || level === 'full'),
      },
    };
  });
}
