// `pnpm db:migrate` — apply pending migrations and exit (the server also migrates on startup).
import { sqlClient } from '../db/client';
import { migrateToLatest } from '../db/migrate';

try {
  await migrateToLatest();
} finally {
  await sqlClient.end();
}
