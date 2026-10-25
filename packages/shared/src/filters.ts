import { z } from 'zod';

export const FILTER_OPS = [
  'is', 'is_not', 'any_of', 'none_of', 'contains', 'not_contains',
  'gt', 'gte', 'lt', 'lte', 'between', 'is_set', 'is_not_set',
] as const;
export type FilterOp = (typeof FILTER_OPS)[number];

/**
 * Built-in filterable fields. Custom fields are `cf:<fieldId>`.
 * Date values accept ISO strings or relative tokens: today, tomorrow, yesterday, this_week, next_week, now.
 */
export const BUILTIN_FILTER_FIELDS = [
  'name', 'status', 'status_group', 'assignee', 'priority', 'tag',
  'due_at', 'start_at', 'created_at', 'updated_at', 'completed_at',
  'list', 'created_by', 'is_subtask',
] as const;

export const filterConditionSchema = z.object({
  field: z.string().min(1),
  op: z.enum(FILTER_OPS),
  value: z.unknown().optional(),
});
export type FilterCondition = z.infer<typeof filterConditionSchema>;

export type FilterGroup = { op: 'and' | 'or'; conditions: Array<FilterCondition | FilterGroup> };
export const filterGroupSchema: z.ZodType<FilterGroup> = z.lazy(() =>
  z.object({
    op: z.enum(['and', 'or']),
    conditions: z.array(z.union([filterConditionSchema, filterGroupSchema])).max(50),
  }),
);
export const isFilterGroup = (c: FilterCondition | FilterGroup): c is FilterGroup =>
  Array.isArray((c as FilterGroup).conditions);

export const GROUP_BY = ['status', 'assignee', 'priority', 'tag', 'due', 'list', 'none'] as const;

export const sortSchema = z.object({ field: z.string(), dir: z.enum(['asc', 'desc']) });

export const viewConfigSchema = z.object({
  filters: filterGroupSchema.optional(),
  groupBy: z.string().default('status'), // one of GROUP_BY or cf:<id>
  sort: z.array(sortSchema).default([]),
  columns: z.array(z.string()).default([]),
  columnWidths: z.record(z.string(), z.number()).default({}),
  showSubtasks: z.boolean().default(false),
  showClosed: z.boolean().default(false),
  dateField: z.enum(['due_at', 'start_at']).default('due_at'),
});
export type ViewConfig = z.infer<typeof viewConfigSchema>;
export const emptyFilter = (): FilterGroup => ({ op: 'and', conditions: [] });
