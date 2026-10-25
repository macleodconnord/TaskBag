# Projects

A self-hosted project-management app that replaces ClickUp for a team of about 10 people.

**Features:** spaces → folders → lists, tasks with subtasks, checklists, dependencies, links, tags, priorities and dates;
List, Board, Table, Calendar and Gantt views with filters and saved views; custom fields (including formulas); task and
list templates; List ↔ Task links with rollups; threaded comments with @mentions; attachments; docs (nested pages with
revisions); search; My Work; in-app inbox and email notifications with digests; sharing and permissions (private items,
guests, groups); Microsoft Entra sign-in; Gitea, NinjaOne (read-only) and outbound webhook integrations; a ClickUp importer.

## Quick start (development)

Requires Node 22+, pnpm (`corepack enable`) and Docker.

```sh
cp .env.example .env     # then set APP_ENCRYPTION_KEY (command is in the file)
pnpm install
pnpm db:up               # Postgres + Mailpit in Docker
pnpm db:seed             # migrations + sample space + dev users
pnpm dev                 # API on :3000, web on http://localhost:8080
```

Sign in with the dev login (pick a seeded user). Emails land in Mailpit at http://localhost:8025.

## Production

```sh
cp .env.example .env     # set APP_ENCRYPTION_KEY, PUBLIC_URL, TRUSTED_PROXY_CIDRS, POSTGRES_PASSWORD; DEV_LOGIN=false
docker compose up -d --build
docker compose exec app node dist/cli.js user:create-breakglass admin@yourco.com   # needs BREAKGLASS_ENABLED=true
```

The app listens on port 8080 (plain HTTP); TLS and the public hostname are handled by the upstream proxy
(see docs/architecture.md §3 for the proxy contract). Sign in with the break-glass account, configure Microsoft Entra
under **Admin → Integrations & credentials**, then sign in with Microsoft and make yourself owner
(`node dist/cli.js user:set-owner you@yourco.com`). Back up the Postgres volume and the `app_data` volume (attachments).

## Docs

- [docs/IMPLEMENTATION.md](docs/IMPLEMENTATION.md) — what was built and how the code is organised (start here)
- [docs/architecture.md](docs/architecture.md), [docs/data-model.md](docs/data-model.md), [docs/permissions.md](docs/permissions.md), [docs/plan.md](docs/plan.md) — the original design
- [CONTRIBUTING.md](CONTRIBUTING.md)
