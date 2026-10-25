# Contributing

Read [docs/IMPLEMENTATION.md](docs/IMPLEMENTATION.md) and [docs/permissions.md](docs/permissions.md) before your first PR.

## 1. Dev setup

1. Install Node 22+, Docker Desktop, and run `corepack enable` (for pnpm). Windows works natively; WSL2 works too.
2. `cp .env.example .env`, set `APP_ENCRYPTION_KEY`, then `pnpm install`.
3. `pnpm db:up` (Postgres + Mailpit), `pnpm db:seed` (migrate + sample data), `pnpm dev`.
4. Open `http://localhost:8080` and use the dev login (`DEV_LOGIN=true`).
5. Useful commands: `pnpm db:reset`, `pnpm db:generate` (migration from schema), `pnpm typecheck`, `pnpm test`, `pnpm ui:smoke` (headless Chrome page check), `pnpm cli`.

Git line endings are LF (`.gitattributes`). Don't change `core.autocrlf`.

## 2. Branching

- **Trunk-based.** `main` is always deployable and protected (PR plus 1 approval plus green CI).
- Short-lived branches (≤ 3 days), named `<type>/<TASK-KEY>-<slug>`, e.g. `feat/OPS-142-board-dnd`.
- Rebase on `main` before merging. **Squash-merge.** The squash title must follow the commit format.

## 3. Commit format

[Conventional Commits](https://www.conventionalcommits.org/) **with the task key**:

```
<type>(<scope>): <summary> [<TASK-KEY>]

feat(tasks): add bulk move between lists [OPS-142]
fix(acl): repoint subtask scopes on move [OPS-201]
```

- Types: `feat`, `fix`, `refactor`, `perf`, `test`, `docs`, `build`, `ci`, `chore`. Scope = the module name.
- Put the task key (e.g. `OPS-142`) or short ID (`#k3x9a2bq`) in the branch name or commit message: the Gitea
  integration uses it to link commits, branches and PRs to the task.

## 4. Code style

- TypeScript `strict`, ESM everywhere, no `any` (use `unknown` and narrow).
- **Validation:** every input crossing a boundary (HTTP, env, integration responses, ClickUp data) is parsed with zod.
  Shared request schemas live in `packages/shared`.
- **Errors:** throw `NotFound`, `Forbidden`, `Conflict`, `Validation` from `apps/server/src/lib/errors.ts`.
- **Naming:** files `kebab-case.ts`, React components `PascalCase.tsx`, DB tables and columns `snake_case`, TS identifiers `camelCase`.
- **Dates:** store `timestamptz` in UTC; format in the user's timezone only in the UI.
- **Modules** talk to each other through exported service functions, not each other's routes.

## 5. Permission rules (non-negotiable)

- Every query that returns securable data filters with `access.filter(table.aclScopeId)`.
- Every mutation calls `access.require(action, type, id)` first (404 when invisible, 403 when too low).
- Every new read surface (endpoint, notification, email, webhook, export) gets a case in the permission tests
  (`packages/shared/src/policy.test.ts`, `apps/server/test/permissions.int.test.ts`).
- ACL, group and role changes call `bumpAcl()` (through `afterCommit` inside a transaction).

## 6. Adding an API module

1. Create `apps/server/src/modules/<name>/routes.ts` (default-export Fastify plugin) and `setup.ts` (event handlers, jobs, extensions).
2. Register the plugin in `src/modules/index.ts` and the setup in `src/setup.ts`.
3. Add tables in `src/db/schema.ts`, run `pnpm db:generate --name <what>`, **review and commit the SQL** in `apps/server/drizzle/`.
4. Put shared request schemas in `packages/shared/src/` and export them from its index.
5. Tests: unit tests next to the code (`*.test.ts`), integration tests against the dev Postgres in `apps/server/test/*.int.test.ts`.

## 7. Adding an integration

Add a descriptor in `packages/shared/src/integrations.ts` (it generates the settings form), read settings with
`getIntegrationConfig(key)`, record runs with `recordRun()`, and implement the "Test connection" check in
`apps/server/src/modules/integrations`. Secrets must never be logged or returned by the API.

## 8. Tests

| Kind | Tool | Where |
|---|---|---|
| Unit | Vitest | next to source, `*.test.ts` |
| Integration (dev Postgres) | Vitest | `apps/server/test/*.int.test.ts` |
| Permission matrix | Vitest | `packages/shared/src/policy.test.ts`, `apps/server/test/permissions.int.test.ts` |
| UI smoke | Playwright (system Chrome) | `tools/ui-smoke.mjs` |

## 9. Pull requests

- Keep PRs under about 400 changed lines where possible.
- The description includes the task link, what changed, how it was tested, screenshots for UI changes, and a migration note if any.
- Checklist: zod validation ✓, access checks ✓, permission tests updated ✓, migration reviewed ✓, docs updated ✓.
