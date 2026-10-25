import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { db, sqlClient } from './client';
import { log } from '../lib/log';

/** Migrations folder: next to the bundle in production, ../../drizzle from source. */
function migrationsFolder() {
  const here = dirname(fileURLToPath(import.meta.url));
  return [resolve(here, 'drizzle'), resolve(here, '../drizzle'), resolve(here, '../../drizzle'), resolve(process.cwd(), 'drizzle')].find((p) => existsSync(p))!;
}

export async function migrateToLatest() {
  await migrate(db, { migrationsFolder: migrationsFolder() });
  log.info('database migrations are up to date');
}

