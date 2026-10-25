# Implementation notes (what was actually built)

The docs in this folder (architecture, data model, permissions, plan) describe a larger design. This app is the
**simplified build for a ~10-person team**. Where this file and the older docs disagree, this file wins.

## What changed from architecture.md

| Original design | Built |
|---|---|
| api + worker processes, BullMQ on Redis, transactional outbox | **One Node process.** In-process event bus (`lib/events.ts`, delivered after commit) and an in-process scheduler (`lib/jobs.ts`). Durable work (emails, webhook deliveries, import runs) lives in DB tables that jobs drain. |
| MinIO + presigned URLs | Files on local disk under `DATA_DIR/attachments`, streamed by the API after an ACL check. |
| Materialized `user_scope_access` | The ACL graph (scopes + entries) is cached in memory and evaluated with the shared `effectiveLevel()`; `bumpAcl()` invalidates. Same semantics (permissions.md §1–2). |
| Delta polling with tombstones/ETags | Plain TanStack Query polling (15 s focused views, 30 s sidebar). |
| Redis pub/sub for config reload | Single process: `invalidateIntegrationConfig()` clears the cache. |
| Mock OIDC container | `DEV_LOGIN=true` shows a "pick a user" login. |
| nginx web container | The API serves the built SPA in production (`apps/web/dist`). |

**Dropped features** (owner decision): audit log, per-task activity history, automations, time tracking, timesheets,
goals, dashboards, backups, monitoring, watchers, comment reactions, assigned comments, Ctrl+K palette, keyboard shortcuts.
Gitea "PR merged → status" is a **per-List setting** (`lists.settings.giteaPrMergedStatusId`) instead of an automation.

## Layout

```
apps/server   Fastify API (+ jobs) — src/modules/<feature>/{routes.ts,setup.ts,...}
apps/web      React SPA (Vite, React Router 7, TanStack Query, Tailwind 4, dnd-kit, TipTap 3)
packages/shared  zod schemas, enums, permission policy, filter AST, rich-text helpers (runs in browser + server)
tools/ui-smoke.mjs  headless-Chrome smoke test (dev login → visit pages → screenshots + console errors)
```

## Running

```sh
cp .env.example .env            # set APP_ENCRYPTION_KEY
pnpm install
pnpm db:up                      # postgres + mailpit (docker compose -f compose.dev.yml)
pnpm db:seed                    # migrate + sample data + dev users
pnpm dev                        # api :3000 (tsx watch) + web :8080 (vite, proxies /api)
```

Run a second API instance for testing on another port: `cd apps/server && PORT=3101 JOBS_ENABLED=false npx tsx --env-file=../../.env src/index.ts`.
On Git Bash prefix commands that pass URL paths with `MSYS_NO_PATHCONV=1`.

## Server conventions

- A module is `src/modules/<name>/routes.ts` (default-export Fastify plugin, mounted at `/api/<prefix>` in
  `modules/index.ts`) plus `setup.ts` (`export async function setup()` — register event handlers, jobs and
  extensions; called once from `src/setup.ts`).
- Validate every input with zod via `parse(schema, data)` (`lib/http.ts`). Throw `NotFound/Forbidden/Validation/Conflict` (`lib/errors.ts`).
- `const { user, access } = auth(req)` gives the session user and `AccessContext`.
- **Permissions (non-negotiable):**
  - Reads of securable rows (spaces, folders, lists, tasks, docs) filter with `await access.filter(table.aclScopeId)`.
  - Single objects: `await access.require(action, type, id)` → 404 if invisible, 403 if too low. Actions: `view, comment, edit, create_child, attach, delete, share, manage` (see `packages/shared/src/policy.ts`).
  - Comments/attachments/checklists/field values inherit their parent task/doc.
  - Aggregates (rollups, counts) count only visible rows.
  - Notifications/emails/webhooks re-check access **for the recipient** with `accessForUser(userId)`.
  - Admin-only endpoints: `access.requireAdmin()`.
- Writes that must be atomic use `runTx(async (tx) => …)`; `emit()` and `bumpAcl()` inside it run after commit.
- Domain events (`lib/events.ts`): `task.created`, `task.updated` (with a field diff), `task.deleted`, `task.assigned`,
  `comment.created` (with mentions), `doc.mentioned`, `external.event`. Subscribe with `on(type, handler)` in a `setup()`.
- Background jobs: `registerJob(name, everyMs, fn)` (`lib/jobs.ts`). Jobs never overlap themselves.
- Task service (`modules/tasks/service.ts`): `createTask`, `updateTask`, `deleteTask`, `duplicateTask`, `findTask`,
  `hydrateTasks`. Integrations and the importer must create/update tasks through these.
- Extension points: `registerTaskDetailExtension(key, fn)` and `registerTaskListExtension(key, fn)` add keys to task
  payloads; `registerListDetailExtension(fn)` adds keys to `GET /hierarchy/lists/:id`; `setListFromTemplateHandler(fn)`.
- Integration settings: `getIntegrationConfig(key)` → `{ enabled, config, secrets }` (secrets decrypted, server-only);
  `saveIntegration()`, `setSecret()`. Never return secret values from the API.
- System users for integrations: `systemUserId('ninjaone' | 'gitea' | 'clickup')` (`db/seed.ts`).
- Schema: `src/db/schema.ts` (Drizzle). After changing it: `pnpm --filter @app/server db:generate --name <what>` and commit the SQL in `apps/server/drizzle/`. Migrations run at startup.

## Web conventions

- Data: `lib/api.ts` (`api.get/post/patch/put/delete/upload`, CSRF handled), hooks in `lib/queries.ts`.
- UI kit: `components/ui.tsx` (Button, Input, Select, Modal, Popover, MenuItem, Tabs, Avatar, Empty, Loading,
  `useDialogs()` confirm/prompt), `components/toast.tsx`, pickers in `components/pickers.tsx`, rich text in `components/editor.tsx`.
- Colors: use the semantic utilities `bg-app bg-subtle bg-muted hover-bg border-app text-app text-muted text-subtle`
  and `accent-*`; dark mode is the `.dark` class (both themes must look right).
- Feature UI lives in `src/features/<feature>/`. The core imports a few fixed components from there
  (e.g. `TaskFieldsSection`, `LinkedListSection`, `DevelopmentSection`, `InboxBadge`, `SpaceDocsNav`) — keep their names and props.
- Open a task in the drawer with `useOpenTask()(key)` (adds `?task=KEY`).

## To confirm before go-live

Built and tested against fakes/fixtures only — verify with real credentials:

- **NinjaOne** (`modules/ninjaone`): board-run response shape (`data`/`tickets`, `lastCursorId` location), ticket field
  names (`summary`, `status.name`, `clientId`, `ticketFormId`, priority values), public log entries
  (`type === 'COMMENT'`, `publicEntry`), whether the `monitoring` scope allows ticketing reads, and that the delta board
  includes a last-updated column (the change hash only covers board columns).
- **ClickUp importer** (`modules/import`): attachments need one task-detail call per task (~2 calls/task → a 10k-task
  import takes 3–4 h at 90 req/min); whether spaces/folders return `members` for private locations (if not, they import
  as admin-only and are reported); field-location endpoints; v3 Docs parameters; view filter translation.
  A CLI import that changes sharing runs in another process — restart the API afterwards so its ACL cache reloads.
- **Entra**: the "Test connection" button and a real sign-in with the groups claim.

## Known limitations

- Calendar shows single-day chips (no multi-day spans); calendar/gantt zoom is remembered per browser.
- Custom field "required" is a marker only; field and option reorder use up/down buttons.
- Templates are visible to every non-guest (no per-scope visibility).
- Docs: no real-time co-editing (the later save wins; page history keeps the other version); no doc templates, covers or
  export; pages reorder with up/down. Docs on a list live in the list's **Doc** tab rather than the sidebar.
- ClickUp deletions and comment edits are not carried over by delta imports; task-level guest shares must be re-shared by hand.
- Gitea `issues` events aren't consumed (links from "Create issue" are written directly).
