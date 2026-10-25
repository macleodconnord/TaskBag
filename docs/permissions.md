# Permission Model

> Status: **Draft for review.** Tables are defined in [data-model.md](data-model.md) §2–3. The engine lives in `packages/shared/src/policy/` (pure, used by the UI) and `packages/db/src/acl/` (SQL filters plus recompute).

## 1. Concepts

| Concept | Values |
|---|---|
| **Workspace role** | `owner` > `admin` > `member` > `guest` |
| **Permission level** | `none` (0) < `view` (1) < `comment` (2) < `edit` (3) < `full` (4) |
| **Principal** | a user or a group (local or Entra-synced). `All Members` is a system group containing every non-guest user. |
| **Securable object** | workspace, space, folder, list, task (including subtasks), doc. Comments, attachments, checklists, time entries, field values and links **take the level of their parent object**. |

**What each level allows**

| Action | view | comment | edit | full |
|---|:-:|:-:|:-:|:-:|
| See object and its children (subject to their own ACLs) | ✓ | ✓ | ✓ | ✓ |
| Comment, react, track time on it, watch | | ✓ | ✓ | ✓ |
| Edit fields, status, assignees; create, move or archive children; attach files | | | ✓ | ✓ |
| Delete; change sharing; make private; manage statuses, fields, views and automations at this scope | | | | ✓ |

**Role rules**
- **Owner and Admin bypass ACLs** and get `full` everywhere. Only the owner can change admins. Admins still appear in the audit log for every change they make.
- **Member** gets whatever `acl_entries` give them, including through `All Members`. By default the root scope grants `All Members → edit`.
- **Guest** gets **only explicit grants** (to the guest or to a group containing the guest). A guest's maximum is capped at `edit` (they can't manage sharing). Guests are never in `All Members`, can't create Spaces, and can't see workspace-wide pages (Everything, people directory) beyond users who share an object with them.
- A **service principal** (system user used for automations and outbound webhooks) is a normal user with role `member` and explicit grants.

## 2. Scopes, inheritance and overrides

Every securable object either **has its own scope** (a row in `acl_scopes`) or **inherits** its parent's. The parent chain is:

```
task(sub) → task(parent) → list → folder? → space → workspace
doc(child) → doc(parent) → list|folder|space container → …
```

An own scope has a **mode**:

| Mode | Meaning | UI label |
|---|---|---|
| `additive` | Effective access = parent scope's access **plus** this scope's entries (max of the two). Used when you "share" a task or list with an extra person or guest without breaking inheritance. | "Share with…" |
| `override` | Effective access = **only** this scope's entries. The parent is ignored. | "Make private" (entries = creator `full`) or "Customize permissions" (entries copied from the current effective list, then edited) |

`acl_scope_id` on each object points to the nearest scope at or above it. Creating an own scope for object X updates `acl_scope_id` for X **and every descendant whose current value equals X's old value** (one recursive UPDATE). This also works for subtask trees through `tasks.path`.

### 2.1 Resolution algorithm (reference implementation in `packages/shared`)

```ts
function effectiveLevel(user, objectScopeId, scopes, entries, memberships): Level {
  if (user.role === 'owner' || user.role === 'admin') return 'full';
  const principals = [ {type:'user', id:user.id},
                       ...memberships(user.id).map(g => ({type:'group', id:g})) ];
  let level = 'none';
  let scope = scopes[objectScopeId];
  while (scope) {
    level = max(level, maxEntryLevel(entries[scope.id], principals));
    if (scope.mode === 'override') break;      // inheritance stops here
    scope = scopes[scope.parent_scope_id];      // additive: keep walking up
  }
  if (user.role === 'guest') level = min(level, 'edit');
  return level;
}
```

The workspace root scope is always `override` with no parent, so the walk always ends.

### 2.2 Materialization: `user_scope_access`

Running that walk per row at query time would be slow and hard to express in SQL. Instead we **materialize** `(user_id, scope_id, level)` for every non-admin user and every scope where level > none.

- Size: ~10 users × (number of scopes). Scopes exist only for objects with custom sharing, so the table will hold a few thousand rows at most.
- `acl.recompute(tx, { scopeIds?, userIds? })` recomputes affected rows **inside the same transaction** as the change:

| Change | Recompute |
|---|---|
| ACL entry added, changed or removed on scope S | All users × (S + all descendant scopes in additive mode) |
| Scope created, deleted or mode changed | Same as above |
| Group membership changed (local edit or Entra login sync) | That user × all scopes |
| User role changed or deactivated | That user × all scopes |
| Object moved to a new parent | Repoint `acl_scope_id` of moved inherit-subtree. If the moved object has an own `additive` scope, update its `parent_scope_id`, then recompute that scope's subtree. |

- After recompute, `permission_versions.version` is bumped for users whose rows changed. Clients see this in the poll cursor and do a full resync (architecture §6).
- A nightly `acl.verify` job recomputes everything into a temp table and diffs it against the live table. Any drift is logged as an error and fixed.

## 3. Enforcement points

All authorization goes through **one module**:

```ts
// packages/shared/src/policy/index.ts  (pure)
can(ctx: AccessContext, action: Action, obj: { level: Level; kind: ObjectKind; ... }): boolean
requiredLevel(action: Action): Level   // single table mapping actions → levels

// apps/api/src/plugins/access.ts
fastify.decorateRequest('access')       // AccessContext {user, role, groupIds, permVersion}
await req.access.require('task.edit', taskId)   // throws 404 if no view, 403 if view but insufficient
```

- **Unauthorized reads return 404**, not 403, so the existence of private objects doesn't leak.
- Every repo function that reads securable rows takes an `AccessContext` and **must** use `withAccess()` (see §4). A lint rule (`no-unscoped-query`, custom ESLint) flags Drizzle `from(tasks|lists|docs|…)` calls in `repo.ts` that don't go through it.
- API responses include `_perms: {level}` on each object so the UI calls `can()` from `packages/shared` to hide controls. **The UI check is cosmetic. The server check is authoritative.**

## 4. Efficient filtering for lists, search, views and aggregates

```ts
// packages/db/src/acl/withAccess.ts
export function visibleTasks(ctx: AccessContext, minLevel: Level = 'view') {
  if (ctx.isAdmin) return db.select().from(tasks);           // bypass
  return db.select().from(tasks)
    .innerJoin(userScopeAccess, and(
      eq(userScopeAccess.scopeId, tasks.aclScopeId),
      eq(userScopeAccess.userId, ctx.userId),
      gte(userScopeAccess.level, minLevel)));
}
```

- This is one indexed equi-join (`user_scope_access PK(user_id, scope_id)` + `tasks(acl_scope_id)`). Postgres builds a small hash of the user's visible scopes (< a few thousand rows) and probes it, so the overhead is negligible at 100k tasks.
- **Views, Table, Board, Calendar, Gantt:** the view's filter AST is applied **on top of** `visibleTasks()`. Group-by counts and sums run on that same filtered CTE.
- **Search:** each `UNION ALL` branch (tasks, comments joined to tasks, docs) uses the same join.
- **Dashboards and goal rollups:** widget queries start from `visibleTasks(ctx)`. **Aggregates count only visible rows.** Hidden tasks are never "counted but redacted", because a count alone can leak information.
- **Subtasks under a visible parent** that have their own private scope are simply absent. The parent's subtask counter is computed with the filter.
- **Lists ↔ Task link rollups:** the rollup aggregates `visibleTasks(ctx)` restricted to the linked List. If the viewer can't see the List itself, the API returns `{ linkedList: { hidden: true } }` with no name and no counts.
- **Breadcrumbs and navigation:** a user who can see an object but not its ancestors (e.g. a guest shared on one task) gets ancestor *names* only, through `ancestorsForNav()`. This is the same "traverse" behavior ClickUp has, and it never exposes sibling objects.
- **Exports (CSV/JSON):** use the same repo functions, so they're always filtered.

## 5. Mutations

- A check is made on the **target** object (and for moves, `edit` on the source **and** destination containers).
- Changing sharing requires `full` on the object. Guests can never change sharing.
- **Every ACL change** (entry add, change or remove, scope create or delete, mode change, role change, group membership change through the UI) writes an `audit_log` row with before and after, in the same transaction.

## 6. Notifications, email and outbound data

Notifications are generated by the worker. **Permission is checked per recipient at send time**, not when the event happens:

1. The fan-out computes candidate recipients (assignees, watchers, mentioned users, automation targets).
2. For each recipient: `effectiveLevel(recipient, task) >= view`? If not, **drop silently**. This includes @mentions of users who can't see the task. The mention still renders in the comment, but they aren't notified, and the author sees a hint in the editor: "X can't see this task".
3. Email bodies are rendered from current data **after** the check. Digest emails re-check every item at digest time.
4. Inbox items are **re-checked when read**. If access was revoked since the item was created, the item renders as "A task you no longer have access to" with no title.
5. **Outbound webhooks** are filtered as their subscription's `acting_user_id`. Payloads for invisible tasks are never sent.
6. **Automation actions** run as `run_as_user_id`. An automation can't read or modify tasks that its service principal can't access.
7. **Gitea and NinjaOne** inbound links attach to tasks regardless of the viewer, because they're data on the task and are gated by the task's own ACL when read.

## 7. ClickUp permission mapping

| ClickUp | Ours | Difference |
|---|---|---|
| Owner / Admin / Member / Guest roles | Same roles | Same |
| Space/Folder/List "private" + shared members | `override` scope with entries | Same |
| Task shared with guest/member (not private) | `additive` scope on the task | Same |
| Permission levels: view / comment / edit / full (Business+) | view / comment / edit / full | Same set. On lower ClickUp plans, every member had full access, so we map to `edit` |
| ClickUp Teams (user groups) | local groups (later linked to Entra) | Mapped by name. Admin confirms in the import mapping step |
| Custom roles (Enterprise) | Not supported | Mapped to the nearest standard role. Reported in the dry run |
| Guest "can see time spent/estimated" toggles | Not supported | All guests see time fields on visible tasks. Reported |

## 8. Test matrix

Tests live in `packages/shared/src/policy/*.test.ts` (pure algorithm, table-driven) and `apps/api/test/permissions/*.int.test.ts` (real Postgres). The integration suite runs **each scenario against every enforcement surface**: GET by ID, list or view query, search, dashboard count, notification fan-out, email render, export and outbound webhook.

**Fixture:** Space `S` → Folder `F` → List `L` → Task `T` → Subtask `ST`. Second List `L2` contains task `P`, which is linked to List `L` through `list_task_links`. Users: `owner`, `admin`, `m1`, `m2` (members), `g1` (guest). Group `GrpA = {m2}`.

| # | Setup | owner | admin | m1 | m2 | g1 |
|---|---|---|---|---|---|---|
| 1 | Default (root: All Members → edit) | full | full | edit on all | edit | none |
| 2 | `S` override: m1 → view | full | full | view S..ST | none | none |
| 3 | `L` override (private): creator m1 full | full | full | full L..ST | none on L..ST, edit S, F | none |
| 4 | `T` additive: g1 → comment | full | full | edit | edit | comment T, ST. Nav names for S/F/L only |
| 5 | `T` additive: g1 → full | – | – | – | – | **edit** (guest cap) |
| 6 | `T` override private (m1 full) | full | full | full T, ST | none T, ST; edit L | none |
| 7 | `ST` override private (m2 full), T inherited | full | full | edit T, **none ST** | edit T, full ST | none |
| 8 | `L` override: GrpA → comment | full | full | none | comment | none |
| 9 | #8, then remove m2 from GrpA | – | – | – | **none** (after recompute) | – |
| 10 | #8, m2's Entra login drops the group | – | – | – | none | – |
| 11 | `F` override (m1 view) + `L` additive (m2 edit) | full | full | view L | edit L | none |
| 12 | Move `T` from `L` (private m1) to `L2` (default) | – | – | edit T | edit T (gained) | – |
| 13 | Move `T` that has an own additive scope (g1 comment) to `L2` | – | – | – | – | still comment T. Parent scope updated |
| 14 | Demote m1 to guest | – | – | only explicit grants, capped at edit | – | – |
| 15 | Deactivate m2 | – | – | – | none everywhere; sessions revoked | – |
| 16 | `L` private (m1); P in L2 is visible to m2 | – | – | rollup counts L's tasks | `linkedList.hidden = true`, no counts | – |
| 17 | `L` visible to m2 but `T` private (m1) | – | – | rollup includes T | rollup **excludes** T from counts | – |

**Cross-surface assertions for every row**
- `GET /tasks/:id` returns 404 when the level is none.
- List, Board, Table, Calendar and Gantt queries plus search exclude invisible rows. Group counts match the visible rows.
- Dashboard `status_counts` and `burndown` totals equal the visible count.
- @mention of an invisible user → no notification row, no email.
- Inbox item for a task that has since become invisible renders redacted.
- Outbound webhook for a task the acting principal can't see → no delivery row.
- Export CSV row count equals the visible count.
- Each ACL mutation in the setup produced exactly one `audit_log` row.
- `acl.verify` reports zero drift after each scenario.

**Property-based test (fast-check):** generate random hierarchies, scopes, entries and memberships, then assert that the SQL `user_scope_access` equals the pure `effectiveLevel()` for every (user, object) pair. This keeps the materialized table and the reference algorithm in sync.
