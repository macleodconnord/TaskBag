import { z } from 'zod';
import { STATUS_GROUPS, WORKSPACE_ROLES } from './enums';

const id = z.string().uuid();
const isoDate = z.string().datetime({ offset: true });
/** TipTap/ProseMirror JSON document. Validated loosely; plain text is derived server-side. */
export const richTextSchema = z.looseObject({ type: z.literal('doc'), content: z.array(z.any()).optional() });
export type RichText = z.infer<typeof richTextSchema>;

// ── hierarchy ──
export const createSpaceSchema = z.object({
  name: z.string().trim().min(1).max(100),
  keyPrefix: z.string().trim().toUpperCase().regex(/^[A-Z][A-Z0-9]{1,9}$/, '2–10 letters/digits, starting with a letter'),
  color: z.string().max(20).optional(),
  private: z.boolean().optional(),
});
export const updateSpaceSchema = z.object({
  name: z.string().trim().min(1).max(100).optional(),
  color: z.string().max(20).nullable().optional(),
  position: z.number().optional(),
  archived: z.boolean().optional(),
});
export const createFolderSchema = z.object({ spaceId: id, name: z.string().trim().min(1).max(100), private: z.boolean().optional() });
export const updateFolderSchema = z.object({
  name: z.string().trim().min(1).max(100).optional(),
  position: z.number().optional(),
  archived: z.boolean().optional(),
});
export const createListSchema = z.object({
  spaceId: id,
  folderId: id.nullable().optional(),
  name: z.string().trim().min(1).max(100),
  private: z.boolean().optional(),
  templateId: id.optional(),
});
export const updateListSchema = z.object({
  name: z.string().trim().min(1).max(100).optional(),
  description: richTextSchema.nullable().optional(),
  position: z.number().optional(),
  archived: z.boolean().optional(),
  /** move: target space (and optional folder in it) */
  spaceId: id.optional(),
  folderId: id.nullable().optional(),
  settings: z.record(z.string(), z.unknown()).optional(),
});

// ── statuses ──
export const statusInputSchema = z.object({
  id: id.optional(),
  name: z.string().trim().min(1).max(50),
  color: z.string().max(20),
  group: z.enum(STATUS_GROUPS),
});
export const saveStatusSetSchema = z.object({
  statuses: z.array(statusInputSchema).min(1).max(30),
  /** old status id → replacement status id, for statuses being removed */
  mapping: z.record(z.string(), z.string()).default({}),
});

// ── tasks ──
export const createTaskSchema = z.object({
  listId: id,
  parentTaskId: id.nullable().optional(),
  name: z.string().trim().min(1).max(500),
  description: richTextSchema.nullable().optional(),
  statusId: id.optional(),
  priority: z.number().int().min(1).max(4).nullable().optional(),
  startAt: isoDate.nullable().optional(),
  dueAt: isoDate.nullable().optional(),
  dueHasTime: z.boolean().optional(),
  timeEstimateMin: z.number().int().min(0).nullable().optional(),
  assigneeIds: z.array(id).optional(),
  tagIds: z.array(id).optional(),
  templateId: id.optional(),
  /** fractional-index position; appended to the end when omitted */
  position: z.string().optional(),
});
export const updateTaskSchema = z.object({
  name: z.string().trim().min(1).max(500).optional(),
  description: richTextSchema.nullable().optional(),
  statusId: id.optional(),
  priority: z.number().int().min(1).max(4).nullable().optional(),
  startAt: isoDate.nullable().optional(),
  dueAt: isoDate.nullable().optional(),
  dueHasTime: z.boolean().optional(),
  timeEstimateMin: z.number().int().min(0).nullable().optional(),
  assigneeIds: z.array(id).optional(),
  tagIds: z.array(id).optional(),
  position: z.string().optional(),
  archived: z.boolean().optional(),
  listId: id.optional(), // move
  parentTaskId: id.nullable().optional(),
});
export type CreateTaskInput = z.infer<typeof createTaskSchema>;
export type UpdateTaskInput = z.infer<typeof updateTaskSchema>;

export const createTagSchema = z.object({ spaceId: id, name: z.string().trim().min(1).max(50), color: z.string().max(20).optional() });

export const checklistSchema = z.object({ name: z.string().trim().min(1).max(200) });
export const checklistItemSchema = z.object({
  name: z.string().trim().min(1).max(500).optional(),
  resolved: z.boolean().optional(),
  assigneeId: id.nullable().optional(),
  parentItemId: id.nullable().optional(),
  position: z.number().optional(),
});

export const dependencySchema = z.object({ dependsOnTaskId: id });
export const linkSchema = z.object({ otherTaskId: id });

// ── comments ──
export const createCommentSchema = z.object({ body: richTextSchema, parentId: id.nullable().optional() });
export const updateCommentSchema = z.object({ body: richTextSchema });

// ── sharing ──
export const shareEntrySchema = z.object({
  principalType: z.enum(['user', 'group']),
  principalId: id,
  level: z.enum(['view', 'comment', 'edit', 'full']),
});
export const saveSharingSchema = z.object({
  /** inherit = no own scope; additive = parent + these; override = only these */
  mode: z.enum(['inherit', 'additive', 'override']),
  entries: z.array(shareEntrySchema).max(200),
});

// ── users & groups ──
export const updateUserSchema = z.object({
  role: z.enum(WORKSPACE_ROLES).optional(),
  isActive: z.boolean().optional(),
  displayName: z.string().trim().min(1).max(100).optional(),
});
export const updateMeSchema = z.object({
  displayName: z.string().trim().min(1).max(100).optional(),
  timezone: z.string().max(64).nullable().optional(),
  theme: z.enum(['system', 'light', 'dark']).optional(),
});
export const groupSchema = z.object({
  name: z.string().trim().min(1).max(100),
  description: z.string().max(500).nullable().optional(),
  entraGroupId: z.string().max(100).nullable().optional(),
  memberIds: z.array(id).optional(),
});
