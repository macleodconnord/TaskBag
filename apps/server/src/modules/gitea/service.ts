import { parseTaskRefs, slugify } from '@app/shared';
import { and, eq, inArray, isNull, or } from 'drizzle-orm';
import { db, type Tx } from '../../db/client';
import { giteaLinks, lists, tasks } from '../../db/schema';
import { systemUserId } from '../../db/seed';
import { emit } from '../../lib/events';
import { log } from '../../lib/log';
import { runTx } from '../../lib/tx';
import { statusesForList } from '../hierarchy/service';
import { updateTask, type TaskRow } from '../tasks/service';

type Kind = 'commit' | 'branch' | 'pr' | 'issue';
export interface LinkInput {
  repo: string;
  kind: Kind;
  ref: string;
  title?: string | null;
  url?: string | null;
  author?: string | null;
  state?: string | null;
  occurredAt?: Date;
}

/** Tasks referenced by `OPS-123` keys or `#shortid` in any of the texts (deleted tasks excluded). */
export async function resolveTaskRefs(tx: Tx, texts: Array<string | null | undefined>): Promise<TaskRow[]> {
  const keys = new Set<string>();
  const shortIds = new Set<string>();
  for (const t of texts) {
    if (!t) continue;
    const r = parseTaskRefs(t);
    r.keys.forEach((k) => keys.add(k));
    r.shortIds.forEach((s) => shortIds.add(s));
  }
  if (!keys.size && !shortIds.size) return [];
  const conds = [];
  if (keys.size) conds.push(inArray(tasks.key, [...keys]));
  if (shortIds.size) conds.push(inArray(tasks.shortId, [...shortIds]));
  return tx.select().from(tasks).where(and(or(...conds), isNull(tasks.deletedAt)));
}

/** Upsert a link; returns the previous state (null if new). */
export async function upsertLink(tx: Tx, taskId: string, l: LinkInput): Promise<{ prevState: string | null; isNew: boolean }> {
  const [prev] = await tx.select({ state: giteaLinks.state }).from(giteaLinks)
    .where(and(eq(giteaLinks.taskId, taskId), eq(giteaLinks.repo, l.repo), eq(giteaLinks.kind, l.kind), eq(giteaLinks.ref, l.ref)));
  const values = {
    taskId, repo: l.repo, kind: l.kind, ref: l.ref,
    title: l.title?.slice(0, 500) ?? null, url: l.url ?? null, author: l.author ?? null, state: l.state ?? null,
    occurredAt: l.occurredAt ?? new Date(),
  };
  await tx.insert(giteaLinks).values(values).onConflictDoUpdate({
    target: [giteaLinks.taskId, giteaLinks.repo, giteaLinks.kind, giteaLinks.ref],
    set: {
      title: values.title,
      url: values.url,
      ...(l.author ? { author: l.author } : {}),
      ...(l.state ? { state: l.state } : {}),
      ...(l.kind === 'pr' || l.kind === 'issue' ? { occurredAt: values.occurredAt } : {}),
    },
  });
  return { prevState: prev?.state ?? null, isNew: !prev };
}

/** PR merged: move the task to its List's `giteaPrMergedStatusId` (if set) as the Gitea system user. */
async function applyPrMerged(tx: Tx, task: TaskRow, actorId: string) {
  const [list] = await tx.select({ settings: lists.settings }).from(lists).where(eq(lists.id, task.listId));
  const target = list?.settings?.giteaPrMergedStatusId;
  if (!target || target === task.statusId) return false;
  const valid = await statusesForList(tx, task.listId);
  if (!valid.some((s) => s.id === target)) return false; // stale setting (status set changed)
  await updateTask(tx, task, { statusId: target }, { actorId });
  return true;
}

interface Repo { full_name?: string; html_url?: string }
interface WebhookStats { [k: string]: unknown; event: string; repo: string | null; links: number; tasks: number; moved: number }

/** Handle one verified Gitea webhook delivery. */
export async function handleGiteaEvent(event: string, payload: Record<string, unknown>): Promise<WebhookStats> {
  const repo = payload.repository as Repo | undefined;
  const repoName = repo?.full_name ?? 'unknown';
  const stats: WebhookStats = { event, repo: repo?.full_name ?? null, links: 0, tasks: 0, moved: 0 };
  const actor = await systemUserId('gitea');
  const touched = new Set<string>();

  await runTx(async (tx) => {
    const link = async (texts: Array<string | null | undefined>, l: LinkInput) => {
      const found = await resolveTaskRefs(tx, texts);
      for (const t of found) {
        await upsertLink(tx, t.id, l);
        stats.links++;
        touched.add(t.id);
      }
      return found;
    };

    if (event === 'push') {
      const ref = String(payload.ref ?? '');
      const branch = ref.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : null;
      const commits = Array.isArray(payload.commits) ? payload.commits as Array<Record<string, unknown>> : [];
      for (const c of commits) {
        const author = c.author as { name?: string; username?: string } | undefined;
        const message = String(c.message ?? '');
        await link([message, branch], {
          repo: repoName, kind: 'commit', ref: String(c.id ?? '').slice(0, 64),
          title: message.split('\n')[0], url: (c.url as string) ?? null,
          author: author?.username || author?.name || null,
          occurredAt: c.timestamp ? new Date(String(c.timestamp)) : undefined,
        });
      }
      if (branch) {
        await link([branch], { repo: repoName, kind: 'branch', ref: branch, title: branch, url: repo?.html_url ? `${repo.html_url}/src/branch/${branch}` : null, state: 'open' });
      }
    } else if (event === 'create') {
      if (payload.ref_type === 'branch') {
        const branch = String(payload.ref ?? '');
        const sender = payload.sender as { login?: string } | undefined;
        await link([branch], {
          repo: repoName, kind: 'branch', ref: branch, title: branch, author: sender?.login ?? null, state: 'open',
          url: repo?.html_url ? `${repo.html_url}/src/branch/${branch}` : null,
        });
      }
    } else if (event === 'pull_request') {
      const pr = (payload.pull_request ?? {}) as Record<string, unknown>;
      const action = String(payload.action ?? '');
      const merged = pr.merged === true;
      const state = merged ? 'merged' : String(pr.state ?? (action === 'closed' ? 'closed' : 'open'));
      const head = pr.head as { ref?: string } | undefined;
      const user = pr.user as { login?: string } | undefined;
      const number = String(pr.number ?? payload.number ?? '');
      const found = await resolveTaskRefs(tx, [pr.title as string, pr.body as string, head?.ref]);
      for (const t of found) {
        const { prevState } = await upsertLink(tx, t.id, {
          repo: repoName, kind: 'pr', ref: number, title: (pr.title as string) ?? null, url: (pr.html_url as string) ?? null,
          author: user?.login ?? null, state,
        });
        stats.links++;
        touched.add(t.id);
        // redeliveries of the same "merged" event are no-ops
        if (merged && prevState !== 'merged') {
          if (await applyPrMerged(tx, t, actor)) stats.moved++;
          emit('external.event', { source: 'gitea', event: 'pr_merged', taskId: t.id, data: { repo: repoName, number, url: pr.html_url ?? null, title: pr.title ?? null } });
        } else if (prevState === null && action === 'opened') {
          emit('external.event', { source: 'gitea', event: 'pr_opened', taskId: t.id, data: { repo: repoName, number, url: pr.html_url ?? null } });
        }
      }
    } else {
      log.debug({ event }, 'gitea webhook: event ignored');
    }

    // bump updated_at so polling clients refresh the Development panel
    if (touched.size) await tx.update(tasks).set({ updatedAt: new Date() }).where(inArray(tasks.id, [...touched]));
  });
  stats.tasks = touched.size;
  return stats;
}

/** Default branch name from the template (`feat/{key}-{slug}`). */
export const branchNameFor = (template: string, task: Pick<TaskRow, 'key' | 'name' | 'shortId'>) =>
  template.replace('{key}', task.key).replace('{slug}', slugify(task.name, 40) || 'task').replace('{shortId}', task.shortId).replace(/\/+$/, '');
