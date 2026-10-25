import { useMutation, useQueryClient } from '@tanstack/react-query';
import { CircleDot, Code2, ExternalLink, GitBranch, GitCommitHorizontal, GitMerge, GitPullRequest, LifeBuoy, Plus } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { api } from '@/lib/api';
import { timeAgo } from '@/lib/format';
import type { TaskDetail } from '@/lib/types';
import { toast } from '@/components/toast';
import { Badge, Button, Field, Input, MenuItem, Modal, Popover, Select, Textarea } from '@/components/ui';

interface GiteaLink {
  id: string;
  repo: string;
  kind: 'commit' | 'branch' | 'pr' | 'issue';
  ref: string;
  title: string | null;
  url: string | null;
  author: string | null;
  state: string | null;
  occurredAt: string;
}
interface Development {
  links: GiteaLink[];
  gitea: { enabled: boolean; repos: string[]; defaultBranchName: string; canCreate: boolean };
}
interface NinjaTicketInfo { ticketId: number; url: string; status: string | null; lastPolledAt: string }

const STATE_COLOR: Record<string, string> = { open: '#16a34a', merged: '#7c3aed', closed: '#dc2626' };
const KIND_ORDER = ['pr', 'branch', 'issue', 'commit'] as const;
const KIND_LABEL: Record<GiteaLink['kind'], string> = { pr: 'Pull requests', branch: 'Branches', issue: 'Issues', commit: 'Commits' };

function KindIcon({ link }: { link: GiteaLink }) {
  const cls = 'size-4 shrink-0';
  if (link.kind === 'pr') return link.state === 'merged' ? <GitMerge className={`${cls} text-violet-600 dark:text-violet-400`} /> : <GitPullRequest className={`${cls} ${link.state === 'closed' ? 'text-red-600 dark:text-red-400' : 'text-emerald-600 dark:text-emerald-400'}`} />;
  if (link.kind === 'branch') return <GitBranch className={`${cls} text-muted`} />;
  if (link.kind === 'issue') return <CircleDot className={`${cls} text-muted`} />;
  return <GitCommitHorizontal className={`${cls} text-muted`} />;
}

/** Task detail "Development" panel (Gitea commits/branches/PRs, NinjaOne ticket link). */
export function DevelopmentSection({ task }: { task: TaskDetail }) {
  const dev = task.development as Development | null | undefined;
  const ticket = task.ninjaTicket as NinjaTicketInfo | null | undefined;
  const [dialog, setDialog] = useState<'branch' | 'issue' | null>(null);
  const [showAllCommits, setShowAllCommits] = useState(false);
  if (!dev && !ticket) return null;
  const links = dev?.links ?? [];
  const canCreate = !!dev?.gitea.canCreate && dev.gitea.repos.length > 0;
  if (!links.length && !ticket && !canCreate) return null;

  return (
    <section className="mt-6">
      <div className="mb-2 flex items-center gap-2">
        <Code2 className="size-4 text-muted" />
        <h3 className="text-sm font-semibold">Development</h3>
        <div className="ml-auto">
          {canCreate && (
            <Popover align="end" width={200} trigger={(p) => <Button {...p} size="sm" variant="ghost"><Plus className="size-3.5" />Create</Button>}>
              {(close) => (
                <>
                  <MenuItem icon={<GitBranch className="size-4" />} onClick={() => { close(); setDialog('branch'); }}>Create branch</MenuItem>
                  <MenuItem icon={<CircleDot className="size-4" />} onClick={() => { close(); setDialog('issue'); }}>Create Gitea issue</MenuItem>
                </>
              )}
            </Popover>
          )}
        </div>
      </div>

      {ticket && (
        <Row icon={<LifeBuoy className="size-4 shrink-0 text-muted" />} href={ticket.url}>
          <span className="font-medium">NinjaOne ticket #{ticket.ticketId}</span>
          {ticket.status && <Badge>{ticket.status}</Badge>}
          <span className="ml-auto shrink-0 text-xs text-subtle">synced {timeAgo(ticket.lastPolledAt)}</span>
        </Row>
      )}

      {KIND_ORDER.map((kind) => {
        let group = links.filter((l) => l.kind === kind);
        if (!group.length) return null;
        const hidden = kind === 'commit' && !showAllCommits ? Math.max(0, group.length - 5) : 0;
        if (hidden) group = group.slice(0, 5);
        return (
          <div key={kind} className="mt-2">
            <div className="mb-0.5 text-[11px] font-semibold uppercase tracking-wide text-subtle">{KIND_LABEL[kind]}</div>
            {group.map((l) => (
              <Row key={l.id} icon={<KindIcon link={l} />} href={l.url}>
                <span className="min-w-0 truncate">
                  {kind === 'pr' || kind === 'issue' ? <span className="text-muted">#{l.ref} </span> : kind === 'commit' ? <span className="font-mono text-xs text-muted">{l.ref.slice(0, 8)} </span> : null}
                  <span className={kind === 'branch' ? 'font-mono text-xs' : ''}>{kind === 'branch' ? l.ref : l.title ?? l.ref}</span>
                </span>
                {l.state && kind !== 'commit' && kind !== 'branch' && <Badge color={STATE_COLOR[l.state] ?? undefined}>{l.state}</Badge>}
                <span className="ml-auto shrink-0 truncate text-xs text-subtle">{l.repo}{l.author ? ` · ${l.author}` : ''} · {timeAgo(l.occurredAt)}</span>
              </Row>
            ))}
            {hidden > 0 && <button className="ml-7 text-xs text-accent-600 hover:underline" onClick={() => setShowAllCommits(true)}>Show {hidden} more</button>}
          </div>
        );
      })}

      {!links.length && !ticket && <p className="text-sm text-subtle">No branches, commits or pull requests yet. Mention <span className="font-mono">{task.key}</span> in a branch name, commit message or PR title to link it.</p>}

      {dialog && dev && <CreateDialog kind={dialog} task={task} dev={dev} onClose={() => setDialog(null)} />}
    </section>
  );
}

function Row({ icon, href, children }: { icon: ReactNode; href: string | null; children: ReactNode }) {
  const inner = (
    <>
      {icon}
      {children}
      {href && <ExternalLink className="size-3 shrink-0 text-subtle opacity-0 group-hover:opacity-100" />}
    </>
  );
  const cls = 'group flex min-w-0 items-center gap-2 rounded-md px-1.5 py-1 text-sm hover-bg';
  return href ? <a className={cls} href={href} target="_blank" rel="noreferrer">{inner}</a> : <div className={cls}>{inner}</div>;
}

function CreateDialog({ kind, task, dev, onClose }: { kind: 'branch' | 'issue'; task: TaskDetail; dev: Development; onClose: () => void }) {
  const qc = useQueryClient();
  const [repo, setRepo] = useState(dev.gitea.repos[0] ?? '');
  const [name, setName] = useState(dev.gitea.defaultBranchName);
  const [from, setFrom] = useState('');
  const [title, setTitle] = useState(`${task.key}: ${task.name}`.slice(0, 250));
  const [body, setBody] = useState('');
  const create = useMutation({
    mutationFn: (): Promise<{ url: string }> => kind === 'branch'
      ? api.post<{ branch: string; url: string }>(`/integrations/gitea/tasks/${task.id}/branch`, { repo, name: name.trim(), ...(from.trim() ? { from: from.trim() } : {}) })
      : api.post<{ number: number; url: string }>(`/integrations/gitea/tasks/${task.id}/issue`, { repo, title: title.trim(), ...(body.trim() ? { body } : {}) }),
    onSuccess: () => {
      toast.ok(kind === 'branch' ? 'Branch created and linked' : 'Issue created and linked');
      void qc.invalidateQueries({ queryKey: ['task'] });
      onClose();
    },
  });
  const valid = repo && (kind === 'branch' ? name.trim() : title.trim());
  return (
    <Modal
      open
      onClose={onClose}
      title={kind === 'branch' ? 'Create branch' : 'Create Gitea issue'}
      width={480}
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" disabled={!valid} loading={create.isPending} onClick={() => create.mutate()}>Create</Button></>}
    >
      <form className="grid gap-3" onSubmit={(e) => { e.preventDefault(); if (valid) create.mutate(); }}>
        <Field label="Repository">
          <Select value={repo} onChange={(e) => setRepo(e.target.value)}>
            {dev.gitea.repos.map((r) => <option key={r} value={r}>{r}</option>)}
          </Select>
        </Field>
        {kind === 'branch' ? (
          <>
            <Field label="Branch name"><Input className="font-mono text-xs" value={name} onChange={(e) => setName(e.target.value)} autoFocus /></Field>
            <Field label="From" hint="empty = the repository's default branch"><Input className="font-mono text-xs" value={from} onChange={(e) => setFrom(e.target.value)} placeholder="main" /></Field>
          </>
        ) : (
          <>
            <Field label="Title"><Input value={title} onChange={(e) => setTitle(e.target.value)} autoFocus /></Field>
            <Field label="Description" hint="a link back to the task is added"><Textarea rows={4} value={body} onChange={(e) => setBody(e.target.value)} /></Field>
          </>
        )}
        <button type="submit" hidden />
      </form>
    </Modal>
  );
}
