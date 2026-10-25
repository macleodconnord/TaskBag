// `pnpm db:seed` — migrate, then add development users and a sample space. Never run in production.
import { sqlClient } from '../db/client';
import { migrateToLatest } from '../db/migrate';
import { seedDev } from '../db/seed';
import { env } from '../env';

if (env.NODE_ENV === 'production') {
  console.error('db:seed is for development only');
  process.exit(1);
}
try {
  await migrateToLatest();
  await seedDev();
} finally {
  await sqlClient.end();
}
