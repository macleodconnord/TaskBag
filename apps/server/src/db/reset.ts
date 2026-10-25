import { sql } from 'drizzle-orm';
import { env } from '../env';
import { db, sqlClient } from './client';

/** Drop everything in the dev database. Refuses to run in production. */
if (env.NODE_ENV === 'production') {
  console.error('db:reset is disabled in production');
  process.exit(1);
}
await db.execute(sql`drop schema if exists public cascade; drop schema if exists drizzle cascade; create schema public;`);
console.log('Database reset. Run `pnpm db:seed` (or start the app) to migrate and seed.');
await sqlClient.end();
