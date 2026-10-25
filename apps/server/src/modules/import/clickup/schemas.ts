import { z } from 'zod';

/**
 * ClickUp API response shapes (v2 + v3 Docs). Only the fields the importer relies on are
 * validated; everything else is tolerated (`looseObject`) so API additions don't break imports.
 * ClickUp sends ids as strings or numbers depending on the endpoint, and timestamps as ms strings.
 */
const sid = z.union([z.string(), z.number()]).transform(String);
const ms = z.union([z.string(), z.number()]).nullish().transform((v) => (v === null || v === undefined || v === '' ? null : Number(v)));

export const cuUserSchema = z.looseObject({
  id: sid,
  username: z.string().nullish(),
  email: z.string().nullish(),
  color: z.string().nullish(),
  profilePicture: z.string().nullish(),
  /** workspace role: 1 owner, 2 admin, 3 member, 4 guest */
  role: z.number().nullish(),
});
export type CuUser = z.infer<typeof cuUserSchema>;

export const cuTeamSchema = z.looseObject({
  id: sid,
  name: z.string(),
  members: z.array(z.looseObject({ user: cuUserSchema })).default([]),
});
export const cuTeamsResponse = z.looseObject({ teams: z.array(cuTeamSchema) });

export const cuGroupSchema = z.looseObject({
  id: sid,
  name: z.string(),
  members: z.array(cuUserSchema).default([]),
});
export const cuGroupsResponse = z.looseObject({ groups: z.array(cuGroupSchema).default([]) });

export const cuStatusSchema = z.looseObject({
  id: z.string().nullish(),
  status: z.string(),
  type: z.string().default('custom'),
  orderindex: z.union([z.string(), z.number()]).transform(Number).default(0),
  color: z.string().nullish(),
});
export type CuStatus = z.infer<typeof cuStatusSchema>;

/** members on private spaces/folders/lists, when the API includes them */
const cuMembers = z.array(z.looseObject({ user: cuUserSchema.optional() }).or(cuUserSchema)).nullish();

export const cuSpaceSchema = z.looseObject({
  id: sid,
  name: z.string(),
  color: z.string().nullish(),
  private: z.boolean().default(false),
  archived: z.boolean().default(false),
  statuses: z.array(cuStatusSchema).default([]),
  members: cuMembers,
});
export type CuSpace = z.infer<typeof cuSpaceSchema>;

export const cuListSchema = z.looseObject({
  id: sid,
  name: z.string(),
  orderindex: z.union([z.string(), z.number()]).transform(Number).default(0),
  content: z.string().nullish(),
  archived: z.boolean().default(false),
  private: z.boolean().nullish(),
  override_statuses: z.boolean().nullish(),
  statuses: z.array(cuStatusSchema).nullish(),
  task_count: z.union([z.string(), z.number()]).nullish().transform((v) => (v == null ? null : Number(v))),
  permission_level: z.string().nullish(),
  folder: z.looseObject({ id: sid, hidden: z.boolean().nullish() }).nullish(),
  space: z.looseObject({ id: sid }).nullish(),
  members: cuMembers,
});
export type CuList = z.infer<typeof cuListSchema>;

export const cuFolderSchema = z.looseObject({
  id: sid,
  name: z.string(),
  orderindex: z.union([z.string(), z.number()]).transform(Number).default(0),
  hidden: z.boolean().default(false),
  archived: z.boolean().default(false),
  private: z.boolean().nullish(),
  override_statuses: z.boolean().nullish(),
  statuses: z.array(cuStatusSchema).nullish(),
  permission_level: z.string().nullish(),
  lists: z.array(cuListSchema).default([]),
  members: cuMembers,
});
export type CuFolder = z.infer<typeof cuFolderSchema>;

export const cuSpacesResponse = z.looseObject({ spaces: z.array(cuSpaceSchema) });
export const cuFoldersResponse = z.looseObject({ folders: z.array(cuFolderSchema) });
export const cuListsResponse = z.looseObject({ lists: z.array(cuListSchema) });
export const cuMembersResponse = z.looseObject({ members: z.array(cuUserSchema).default([]) });

export const cuFieldSchema = z.looseObject({
  id: z.string(),
  name: z.string(),
  type: z.string(),
  type_config: z.record(z.string(), z.unknown()).nullish().transform((v) => v ?? {}),
  required: z.boolean().nullish(),
  hide_from_guests: z.boolean().nullish(),
  /** present on task.custom_fields when a value is set */
  value: z.unknown().optional(),
});
export type CuField = z.infer<typeof cuFieldSchema>;
export const cuFieldsResponse = z.looseObject({ fields: z.array(cuFieldSchema).default([]) });

export const cuChecklistItemSchema: z.ZodType<CuChecklistItem> = z.lazy(() =>
  z.looseObject({
    id: sid,
    name: z.string().default(''),
    orderindex: z.union([z.string(), z.number()]).transform(Number).default(0),
    resolved: z.boolean().default(false),
    assignee: cuUserSchema.nullish(),
    parent: sid.nullish(),
    children: z.array(z.union([cuChecklistItemSchema, z.string()])).default([]),
  }),
) as never;
export interface CuChecklistItem {
  id: string;
  name: string;
  orderindex: number;
  resolved: boolean;
  assignee?: CuUser | null;
  parent?: string | null;
  children: Array<CuChecklistItem | string>;
}

export const cuAttachmentSchema = z.looseObject({
  id: sid,
  title: z.string().nullish(),
  url: z.string(),
  extension: z.string().nullish(),
  mimetype: z.string().nullish(),
  size: z.union([z.string(), z.number()]).nullish().transform((v) => (v == null ? null : Number(v))),
  date: ms,
  user: cuUserSchema.nullish(),
});
export type CuAttachment = z.infer<typeof cuAttachmentSchema>;

export const cuTaskSchema = z.looseObject({
  id: z.string(),
  custom_id: z.string().nullish(),
  name: z.string(),
  text_content: z.string().nullish(),
  description: z.string().nullish(),
  markdown_description: z.string().nullish(),
  status: z.looseObject({ status: z.string(), type: z.string().nullish(), color: z.string().nullish() }),
  orderindex: z.union([z.string(), z.number()]).nullish(),
  date_created: ms,
  date_updated: ms,
  date_closed: ms,
  date_done: ms,
  archived: z.boolean().default(false),
  creator: cuUserSchema.nullish(),
  assignees: z.array(cuUserSchema).default([]),
  watchers: z.array(cuUserSchema).nullish(),
  checklists: z.array(z.looseObject({
    id: sid,
    name: z.string(),
    orderindex: z.union([z.string(), z.number()]).transform(Number).default(0),
    items: z.array(cuChecklistItemSchema).default([]),
  })).default([]),
  tags: z.array(z.looseObject({ name: z.string(), tag_bg: z.string().nullish(), tag_fg: z.string().nullish() })).default([]),
  parent: z.string().nullish(),
  priority: z.looseObject({ id: sid.nullish(), priority: z.string().nullish() }).nullish(),
  due_date: ms,
  due_date_time: z.boolean().nullish(),
  start_date: ms,
  time_estimate: z.union([z.string(), z.number()]).nullish().transform((v) => (v == null ? null : Number(v))),
  time_spent: z.union([z.string(), z.number()]).nullish().transform((v) => (v == null ? null : Number(v))),
  custom_fields: z.array(cuFieldSchema).default([]),
  dependencies: z.array(z.looseObject({ task_id: z.string(), depends_on: z.string(), type: z.number().nullish() })).default([]),
  linked_tasks: z.array(z.looseObject({ task_id: z.string(), link_id: z.string() })).default([]),
  list: z.looseObject({ id: sid }),
  folder: z.looseObject({ id: sid }).nullish(),
  space: z.looseObject({ id: sid }).nullish(),
  /** only on GET /task/:id (sometimes also in list responses) */
  attachments: z.array(cuAttachmentSchema).optional(),
});
export type CuTask = z.infer<typeof cuTaskSchema>;
export const cuTasksResponse = z.looseObject({ tasks: z.array(cuTaskSchema), last_page: z.boolean().nullish() });

/** Comment rich-text ops: `{ text, attributes? }`, mentions `{ type: 'tag', user }`, files `{ type: 'attachment', attachment }` */
export const cuCommentOpSchema = z.looseObject({
  text: z.string().nullish(),
  type: z.string().nullish(),
  attributes: z.record(z.string(), z.unknown()).nullish(),
  user: cuUserSchema.nullish(),
  attachment: z.looseObject({ id: sid.nullish(), title: z.string().nullish(), url: z.string().nullish() }).nullish(),
});
export type CuCommentOp = z.infer<typeof cuCommentOpSchema>;

export const cuCommentSchema = z.looseObject({
  id: sid,
  comment: z.array(cuCommentOpSchema).default([]),
  comment_text: z.string().nullish(),
  user: cuUserSchema.nullish(),
  date: ms,
  reply_count: z.union([z.string(), z.number()]).nullish().transform((v) => Number(v ?? 0)),
  assignee: cuUserSchema.nullish(),
  reactions: z.array(z.unknown()).nullish(),
});
export type CuComment = z.infer<typeof cuCommentSchema>;
export const cuCommentsResponse = z.looseObject({ comments: z.array(cuCommentSchema).default([]) });

export const cuViewSchema = z.looseObject({
  id: z.string(),
  name: z.string(),
  type: z.string(),
  parent: z.looseObject({ id: sid, type: z.number() }).nullish(),
  grouping: z.looseObject({ field: z.string().nullish(), dir: z.number().nullish() }).nullish(),
  sorting: z.looseObject({ fields: z.array(z.looseObject({ field: z.string(), dir: z.number().nullish() })).default([]) }).nullish(),
  filters: z.looseObject({
    op: z.string().nullish(),
    fields: z.array(z.looseObject({ field: z.string(), op: z.string(), values: z.array(z.unknown()).nullish() })).default([]),
    search: z.string().nullish(),
    show_closed: z.boolean().nullish(),
  }).nullish(),
  columns: z.looseObject({ fields: z.array(z.looseObject({ field: z.string(), hidden: z.boolean().nullish(), width: z.number().nullish() })).default([]) }).nullish(),
  settings: z.looseObject({ show_subtasks: z.number().nullish(), show_closed_subtasks: z.boolean().nullish() }).nullish(),
  visibility: z.string().nullish(),
  protected: z.boolean().nullish(),
  creator: z.union([z.number(), z.string()]).nullish(),
});
export type CuView = z.infer<typeof cuViewSchema>;
export const cuViewsResponse = z.looseObject({ views: z.array(cuViewSchema).default([]) });

// ── v3 Docs ──
export const cuDocSchema = z.looseObject({
  id: z.string(),
  name: z.string().default('Untitled'),
  /** parent.type: 4 space, 5 folder, 6 list, 7 everything, 12 workspace */
  parent: z.looseObject({ id: sid, type: z.number() }).nullish(),
  creator: z.union([z.number(), z.string()]).nullish().transform((v) => (v == null ? null : String(v))),
  date_created: ms,
  date_updated: ms,
  deleted: z.boolean().nullish(),
  archived: z.boolean().nullish(),
});
export type CuDoc = z.infer<typeof cuDocSchema>;
export const cuDocsResponse = z.looseObject({ docs: z.array(cuDocSchema).default([]), next_cursor: z.string().nullish() });

export interface CuPage {
  id: string;
  name: string;
  content: string;
  parent_page_id?: string | null;
  creator_id?: string | null;
  date_created?: number | null;
  archived?: boolean | null;
  pages: CuPage[];
}
export const cuPageSchema: z.ZodType<CuPage> = z.lazy(() =>
  z.looseObject({
    id: z.string(),
    name: z.string().nullish().transform((v) => v || 'Untitled'),
    content: z.string().nullish().transform((v) => v ?? ''),
    parent_page_id: z.string().nullish(),
    creator_id: z.union([z.number(), z.string()]).nullish().transform((v) => (v == null ? null : String(v))),
    date_created: ms,
    archived: z.boolean().nullish(),
    pages: z.array(cuPageSchema).default([]),
  }),
) as never;
export const cuPagesResponse = z.union([z.array(cuPageSchema), z.looseObject({ pages: z.array(cuPageSchema) }).transform((r) => r.pages)]);
