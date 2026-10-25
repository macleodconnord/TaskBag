import { env } from '../env';
import { log } from './log';

/**
 * Tiny in-process scheduler (replaces BullMQ). Each job never overlaps itself.
 * Durable work (emails, webhook deliveries, imports) lives in DB tables that jobs drain,
 * so a restart just picks up where it left off.
 */
interface Job {
  name: string;
  everyMs: number;
  run: () => Promise<unknown>;
  running: boolean;
  timer?: NodeJS.Timeout;
}
const jobs = new Map<string, Job>();
let started = false;

export function registerJob(name: string, everyMs: number, run: () => Promise<unknown>) {
  const job: Job = { name, everyMs, run, running: false };
  jobs.set(name, job);
  if (started) schedule(job);
}

async function tick(job: Job) {
  if (job.running) return;
  job.running = true;
  try {
    await job.run();
  } catch (err) {
    log.error({ err, job: job.name }, 'job failed');
  } finally {
    job.running = false;
  }
}

function schedule(job: Job) {
  job.timer = setInterval(() => void tick(job), job.everyMs);
  job.timer.unref();
  setTimeout(() => void tick(job), 2_000).unref();
}

export function startJobs() {
  if (!env.JOBS_ENABLED || started) return;
  started = true;
  for (const job of jobs.values()) schedule(job);
  log.info({ jobs: [...jobs.keys()] }, 'background jobs started');
}

export function stopJobs() {
  for (const job of jobs.values()) if (job.timer) clearInterval(job.timer);
  started = false;
}
