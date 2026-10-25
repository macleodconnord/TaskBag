import type { Level, RichText } from '@app/shared';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { POLL_FAST, POLL_SLOW, queryClient } from '@/lib/queries';
import type { Attachment, MiniUser } from '@/lib/types';

export type ContainerType = 'space' | 'folder' | 'list';

export interface DocListItem {
  id: string;
  parentDocId: string | null;
  title: string;
  position: number;
  archivedAt: string | null;
  updatedAt: string;
  createdBy: string;
  _perms: { level: Level };
}

export interface DocDetail {
  id: string;
  parentDocId: string | null;
  containerType: ContainerType;
  containerId: string;
  title: string;
  content: RichText | null;
  position: number;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
  level: Level;
  ancestors: Array<{ id: string; title: string; visible: boolean }>;
  path: Array<{ type: ContainerType; id: string; name: string }>;
  children: Array<{ id: string; title: string; position: number; updatedAt: string }>;
  attachments: Attachment[];
  creator: MiniUser | null;
  updater: MiniUser | null;
}

export interface Revision {
  id: string;
  title: string;
  createdAt: string;
  author: MiniUser | null;
}

export interface TaskRefInfo {
  ref: string;
  id: string;
  key: string;
  name: string;
  completedAt: string | null;
  status: { name: string; color: string; group: 'open' | 'active' | 'done' | 'closed' } | null;
}

export const dkeys = {
  container: (t: string, id: string) => ['docs', 'container', t, id] as const,
  doc: (id: string) => ['docs', 'doc', id] as const,
  revisions: (id: string) => ['docs', 'revisions', id] as const,
  taskRefs: (id: string, refs: string) => ['docs', 'task-refs', id, refs] as const,
};

export const useContainerDocs = (containerType: ContainerType, containerId: string) =>
  useQuery({
    queryKey: dkeys.container(containerType, containerId),
    queryFn: () => api.get<DocListItem[]>(`/docs?containerType=${containerType}&containerId=${containerId}`),
    refetchInterval: POLL_SLOW,
  });

export const useDoc = (id: string | undefined) =>
  useQuery({ queryKey: dkeys.doc(id ?? ''), queryFn: () => api.get<DocDetail>(`/docs/${id}`), enabled: !!id, refetchInterval: POLL_FAST });

export const refreshDocs = () => queryClient.invalidateQueries({ queryKey: ['docs'] });

export async function createDoc(input: { containerType?: ContainerType; containerId?: string; parentDocId?: string | null; title?: string }) {
  const d = await api.post<{ id: string }>('/docs', input);
  void refreshDocs();
  return d;
}

export const canEdit = (l: Level | undefined) => l === 'edit' || l === 'full';

/** Task references in doc content: task links (/t/KEY), taskRef nodes and plain keys like OPS-12. */
export function findTaskRefs(content: unknown): string[] {
  const refs = new Set<string>();
  type N = { type?: string; text?: string; attrs?: Record<string, unknown>; marks?: Array<{ type: string; attrs?: Record<string, unknown> }>; content?: N[] };
  const walk = (n: N) => {
    if (!n || typeof n !== 'object') return;
    if (n.type === 'taskRef') {
      const r = n.attrs?.key ?? n.attrs?.id;
      if (typeof r === 'string') refs.add(r);
    }
    if (n.type === 'text' && n.text) {
      for (const m of n.text.matchAll(/\b[A-Z][A-Z0-9]{1,9}-\d{1,7}\b/g)) refs.add(m[0]);
      for (const mark of n.marks ?? []) {
        const href = mark.type === 'link' ? String(mark.attrs?.href ?? '') : '';
        const m = href.match(/\/t\/([A-Za-z0-9-]+)/);
        if (m) refs.add(m[1]);
      }
    }
    n.content?.forEach(walk);
  };
  walk(content as N);
  return [...refs].slice(0, 100);
}
