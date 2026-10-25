import { mkdir } from 'node:fs/promises';
import { env } from './env';
import { buildApp } from './app';
import { migrateToLatest } from './db/migrate';
import { ensureBaseData } from './db/seed';
import { seedIntegrationsFromEnv } from './lib/integration-config';
import { startJobs, stopJobs } from './lib/jobs';
import { log } from './lib/log';
import { setupModules } from './setup';
import { sqlClient } from './db/client';

async function main() {
  await mkdir(env.DATA_DIR, { recursive: true });
  await migrateToLatest();
  await ensureBaseData();
  await seedIntegrationsFromEnv();
  await setupModules();
  const app = await buildApp();
  await app.listen({ port: env.PORT, host: env.HOST });
  startJobs();

  const shutdown = async (signal: string) => {
    log.info({ signal }, 'shutting down');
    stopJobs();
    await app.close();
    await sqlClient.end({ timeout: 5 });
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err) => {
  log.fatal({ err }, 'failed to start');
  process.exit(1);
});
