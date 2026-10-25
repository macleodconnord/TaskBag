import type { Level, RichText, StatusGroup, WorkspaceRole } from '@app/shared';

export type Perms = { _perms: { level: Level } };

export interface Me {
  id: string;
  email: string;
  displayName: string;
  role: WorkspaceRole;
  isActive: boolean;
  isBreakglass: boolean;
  timezone: string | null;
  theme: 'system' | 'light' | 'dark';
  avatarUrl: string | null;
}

export interface User {
  id: string;
  email: string;
  displayName: string;
  avatarUrl: string | null;
  role: WorkspaceRole;
  isActive: boolean;
  isSystem: boolean;
  isPlaceholder: boolean;
  entraLinked: boolean;
  lastLoginAt: string | null;
  isBreakglass: boolean;
}

export interface Group {
  id: string;
  name: string;
  description: string | null;
  source: 'local' | 'entra';
  entraGroupId: string | null;
  isSystem: boolean;
  members: Array<{ userId: string; source: 'local' | 'entra' }>;
}

export interface Status {
  id: string;
  statusSetId: string;
  name: string;
  color: string;
  group: StatusGroup;
  position: number;
}

export interface TreeList extends Perms {
  id: string;
  name: string;
  spaceId: string;
  folderId: string | null;
  position: number;
  archivedAt: string | null;
  navOnly: boolean;
}
export interface TreeFolder extends Perms {
  id: string;
  name: string;
  spaceId: string;
  position: number;
  archivedAt: string | null;
  navOnly: boolean;
  lists: TreeList[];
}
export interface TreeSpace extends Perms {
  id: string;
  name: string;
  color: string | null;
  keyPrefix: string;
  position: number;
  archivedAt: string | null;
  navOnly: boolean;
  folders: TreeFolder[];
  lists: TreeList[];
}
export interface Tree {
  spaces: TreeSpace[];
  canCreateSpace: boolean;
}

export interface ListPath {
  space: { id: string; name: string; color: string | null; keyPrefix: string };
  folder: { id: string; name: string } | null;
  list: { id: string; name: string };
}

export interface ListDetail extends Perms {
  id: string;
  name: string;
  spaceId: string;
  folderId: string | null;
  description: RichText | null;
  statusSetId: string | null;
  settings: Record<string, unknown>;
  path: ListPath;
  statuses: Status[];
  hasOwnStatuses: boolean;
  navOnly: boolean;
  [ext: string]: unknown;
}

export interface MiniUser {
  id: string;
  displayName: string;
  avatarUrl: string | null;
}
export interface Tag {
  id: string;
  spaceId?: string;
  name: string;
  color: string;
}

export interface Task extends Perms {
  id: string;
  listId: string;
  parentTaskId: string | null;
  key: string;
  shortId: string;
  seq: number;
  name: string;
  statusId: string;
  status: Status | null;
  priority: number | null;
  startAt: string | null;
  dueAt: string | null;
  dueHasTime: boolean;
  timeEstimateMin: number | null;
  position: string;
  createdBy: string | null;
  archivedAt: string | null;
  deletedAt: string | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
  source: string;
  assignees: MiniUser[];
  tags: Tag[];
  subtaskCount: number;
  subtaskDoneCount: number;
  checklistTotal: number;
  checklistDone: number;
  /** extension data (custom field values, list-link progress, …) */
  [ext: string]: unknown;
}

export interface TaskRef {
  id: string;
  key: string;
  name: string;
  statusId: string;
  completedAt: string | null;
}

export interface ChecklistItem {
  id: string;
  checklistId: string;
  parentItemId: string | null;
  name: string;
  assigneeId: string | null;
  resolved: boolean;
  position: number;
}
export interface Checklist {
  id: string;
  taskId: string;
  name: string;
  position: number;
  items: ChecklistItem[];
}

export interface Attachment {
  id: string;
  taskId: string | null;
  commentId: string | null;
  docId: string | null;
  uploaderId: string;
  filename: string;
  contentType: string;
  sizeBytes: number;
  createdAt: string;
}

export interface TaskDetail extends Task {
  description: RichText | null;
  level: Level;
  parent: { id: string; key: string; name: string } | null;
  creator: { id: string; displayName: string } | null;
  path: ListPath | null;
  statuses: Status[];
  subtasks: Task[];
  checklists: Checklist[];
  waitingOn: TaskRef[];
  blocking: TaskRef[];
  linkedTasks: TaskRef[];
  attachments: Attachment[];
}

export interface Comment {
  id: string;
  taskId: string | null;
  docId: string | null;
  parentId: string | null;
  authorId: string;
  body: RichText | null;
  editedAt: string | null;
  deletedAt: string | null;
  createdAt: string;
  author: { id: string; displayName: string; avatarUrl: string | null; isSystem: boolean } | null;
  attachments: Attachment[];
}
