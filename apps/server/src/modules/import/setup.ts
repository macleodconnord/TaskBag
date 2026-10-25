import { env } from '../../env';
import { log } from '../../lib/log';
import { resumeInterruptedRuns } from './runner';

/**
 * Startup wiring for the ClickUp importer: continue an import that was running when the process
 * stopped (it resumes from its checkpoint cursor). Skipped when JOBS_ENABLED=false so test/second
 * API instances never pick up a run; a cross-process advisory lock guards against double execution.
 */
export async function setup() {
  if (!env.JOBS_ENABLED) return;
  setTimeout(() => {
    resumeInterruptedRuns().catch((err) => log.error({ err }, 'import: could not resume interrupted runs'));
  }, 3000).unref();
}
