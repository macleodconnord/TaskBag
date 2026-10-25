import { viewConfigSchema, type ViewConfig, type ViewType } from '@app/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, qs } from '@/lib/api';
import { POLL_SLOW } from '@/lib/queries';

export type ScopeType = 'space' | 'folder' | 'list' | 'everything';
export interface ScopeRef { type: ScopeType; id?: string }

export interface SavedView {
  id: string;
  scopeType: ScopeType;
  scopeId: string | null;
  type: ViewType;
  name: string;
  visibility: 'personal' | 'shared';
  ownerId: string;
  config: ViewConfig;
  position: number;
  isDefault: boolean;
  createdAt: string;
  updatedAt: string;
  /** may the caller rename/configure/delete it */
  canEdit: boolean;
}

export const viewKeys = {
  scope: (s: ScopeRef) => ['views', s.type, s.id ?? ''] as const,
};

export const defaultConfig = (): ViewConfig => viewConfigSchema.parse({});

export function useSavedViews(scope: ScopeRef, enabled = true) {
  return useQuery({
    queryKey: viewKeys.scope(scope),
    queryFn: () => api.get<{ views: SavedView[]; canShare: boolean }>(`/views${qs({ scopeType: scope.type, scopeId: scope.id })}`),
    enabled: enabled && (scope.type === 'everything' || !!scope.id),
    refetchInterval: POLL_SLOW,
  });
}

export function useViewMutations(scope: ScopeRef) {
  const qc = useQueryClient();
  const invalidate = () => qc.invalidateQueries({ queryKey: viewKeys.scope(scope) });
  const create = useMutation({
    mutationFn: (input: { type: ViewType; name: string; visibility: 'personal' | 'shared'; config: ViewConfig; isDefault?: boolean }) =>
      api.post<SavedView>('/views', { scopeType: scope.type, scopeId: scope.id ?? null, ...input }),
    onSuccess: () => invalidate(),
  });
  const update = useMutation({
    mutationFn: ({ id, ...input }: { id: string } & Partial<Pick<SavedView, 'name' | 'type' | 'visibility' | 'config' | 'isDefault' | 'position'>>) =>
      api.patch<SavedView>(`/views/${id}`, input),
    onSuccess: (v) => {
      qc.setQueryData<{ views: SavedView[]; canShare: boolean }>(viewKeys.scope(scope), (old) =>
        old ? { ...old, views: old.views.map((x) => (x.id === v.id ? v : v.isDefault && x.visibility === v.visibility ? { ...x, isDefault: false } : x)) } : old);
      void invalidate();
    },
  });
  const remove = useMutation({
    mutationFn: (id: string) => api.delete(`/views/${id}`),
    onSuccess: () => invalidate(),
  });
  return { create, update, remove };
}

/** Dependency pairs among the given (visible) tasks, for Gantt arrows. */
export function useDependencyPairs(taskIds: string[]) {
  const sorted = [...taskIds].sort();
  return useQuery({
    queryKey: ['view-deps', sorted.join(',')],
    queryFn: () => api.post<Array<{ taskId: string; dependsOnTaskId: string }>>('/views/dependencies', { taskIds: sorted }),
    enabled: sorted.length > 0,
    staleTime: 10_000,
    refetchInterval: POLL_SLOW,
  });
}
