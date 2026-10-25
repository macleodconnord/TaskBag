/** Load the repo .env for integration tests (import this before any server module). */
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const envFile = resolve(dirname(fileURLToPath(import.meta.url)), '../../../.env');
if (!process.env.APP_ENCRYPTION_KEY && existsSync(envFile)) process.loadEnvFile(envFile);
process.env.JOBS_ENABLED ??= 'false';
process.env.LOG_LEVEL ??= 'warn';
