import type { CreateTaskInput, UpdateTaskInput } from '@app/shared';
import { QueryClient, useMutation, useQuery, useQueryClient, type QueryKey } from '@tanstack/react-query';
import { api, qs } from './api';
import type { Group, ListDetail, Me, Task, TaskDetail, Tag, Tree, User } from './types';
import { toast } from '@/components/toast';

/** Polling cadence (architecture §6): focused views 15s, sidebar/badges 30s, paused when hidden. */
export const POLL_FAST = 15_000;
export const POLL_SLOW = 30_000;

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 5_000,
      refetchOnWindowFocus: true,
      refetchIntervalInBackground: false,
      retry: (n, err) => n < 2 && !(err && typeof err === 'object' && 'status' in err && [401, 403, 404].includes(err.status as number)),
    },
    mutations: {
      onError: (err) => toast.error(err instanceof Error ? err.message : 'Something went wrong'),
    },
  },
});

export const keys = {
  me: ['me'] as const,
  tree: ['tree'] as const,
  users: ['users'] as const,
  groups: ['groups'] as const,
  list: (id: string) => ['list', id] as const,
  tasks: (params: Record<string, unknown>) => ['tasks', params] as const,
  task: (ref: string) => ['task', ref] as const,
  comments: (kind: string, id: string) => ['comments', kind, id] as const,
  tags: (spaceId?: string) => ['tags', spaceId ?? 'all'] as const,
};

export const useMe = () =>
  useQuery({ queryKey: keys.me, queryFn: () => api.get<{ user: Me; viaBreakglass: boolean }>('/auth/me'), staleTime: 60_000, retry: false });

export const useTree = () =>
  useQuery({ queryKey: keys.tree, queryFn: () => api.get<Tree>('/hierarchy/tree'), refetchInterval: POLL_SLOW });

export const useUsers = () =>
  useQuery({ queryKey: keys.users, queryFn: () => api.get<User[]>('/users'), staleTime: 60_000 });

export const useGroups = () =>
  useQuery({ queryKey: keys.groups, queryFn: () => api.get<Group[]>('/users/groups'), staleTime: 60_000 });

export const useList = (id: string | undefined) =>
  useQuery({ queryKey: keys.list(id ?? ''), queryFn: () => api.get<ListDetail>(`/hierarchy/lists/${id}`), enabled: !!id, refetchInterval: POLL_SLOW });

export const useTags = (spaceId?: string) =>
  useQuery({ queryKey: keys.tags(spaceId), queryFn: () => api.get<Tag[]>(`/tasks/tags/all${qs({ spaceId })}`), staleTime: 30_000 });

export type TaskQuery = {
  listId?: string;
  folderId?: string;
  spaceId?: string;
  parentTaskId?: string;
  filter?: string;
  sort?: string;
  includeClosed?: boolean;
  includeSubtasks?: boolean;
  archived?: boolean;
  q?: string;
};

export const useTasks = (params: TaskQuery, enabled = true) =>
  useQuery({
    queryKey: keys.tasks(params),
    queryFn: () => api.get<Task[]>(`/tasks${qs(params as Record<string, string | boolean | undefined>)}`),
    refetchInterval: POLL_FAST,
    enabled,
  });

export const useTask = (ref: string | null | undefined) =>
  useQuery({ queryKey: keys.task(ref ?? ''), queryFn: () => api.get<TaskDetail>(`/tasks/${ref}`), enabled: !!ref, refetchInterval: POLL_FAST });

/** Patch every cached copy of a task (list queries + detail) — used for optimistic updates. */
function patchTaskCaches(qc: QueryClient, id: string, patch: (t: Task) => Task) {
  const snapshots: Array<[QueryKey, unknown]> = [];
  for (const [key, data] of qc.getQueriesData<Task[] | TaskDetail>({ predicate: (q) => q.queryKey[0] === 'tasks' || q.queryKey[0] === 'task' })) {
    snapshots.push([key, data]);
    if (Array.isArray(data)) qc.setQueryData(key, data.map((t) => (t.id === id ? patch(t) : t)));
    else if (data && data.id === id) qc.setQueryData(key, patch(data) as TaskDetail);
  }
  return () => snapshots.forEach(([k, d]) => qc.setQueryData(k, d));
}

export function useUpdateTask() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...input }: UpdateTaskInput & { id: string }) => api.patch<Task>(`/tasks/${id}`, input),
    onMutate: async ({ id, ...input }) => {
      await qc.cancelQueries({ predicate: (q) => q.queryKey[0] === 'tasks' || q.queryKey[0] === 'task' });
      const users = qc.getQueryData<User[]>(keys.users) ?? [];
      return {
        rollback: patchTaskCaches(qc, id, (t) => {
          const next: Task = { ...t };
          for (const [k, v] of Object.entries(input)) if (k !== 'assigneeIds' && k !== 'tagIds' && k !== 'description') (next as Record<string, unknown>)[k] = v;
          if (input.statusId) {
            const status = (t as TaskDetail).statuses?.find((s) => s.id === input.statusId);
            if (status) next.status = status;
          }
          if (input.assigneeIds) next.assignees = input.assigneeIds.map((uid) => users.find((u) => u.id === uid) ?? { id: uid, displayName: '…', avatarUrl: null });
          return next;
        }),
      };
    },
    onError: (err, _v, ctx) => {
      ctx?.rollback();
      toast.error(err instanceof Error ? err.message : 'Update failed');
    },
    onSettled: (_d, _e, v) => {
      void qc.invalidateQueries({ queryKey: ['tasks'] });
      void qc.invalidateQueries({ queryKey: keys.task(v.id) });
      void qc.invalidateQueries({ predicate: (q) => q.queryKey[0] === 'task' });
    },
  });
}

export function useCreateTask() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateTaskInput) => api.post<Task>('/tasks', input),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['tasks'] });
      void qc.invalidateQueries({ predicate: (q) => q.queryKey[0] === 'task' });
    },
  });
}

export function useDeleteTask() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.delete(`/tasks/${id}`),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['tasks'] });
      void qc.invalidateQueries({ predicate: (q) => q.queryKey[0] === 'task' });
    },
  });
}

/** Invalidate everything task-related after a mutation elsewhere (comments, checklists, …). */
export const refreshTasks = (qc: QueryClient) => {
  void qc.invalidateQueries({ queryKey: ['tasks'] });
  void qc.invalidateQueries({ predicate: (q) => q.queryKey[0] === 'task' });
};
