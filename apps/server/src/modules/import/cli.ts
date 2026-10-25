import { db } from '../../db/client';
import { importRuns, importUserMappings } from '../../db/schema';
import { eq } from 'drizzle-orm';
import { createClickUpClient } from './clickup/client';
import { STAGE_LABELS, type RunMode, type Stage } from './context';
import { runView } from './report';
import { activeRun, createRun, launch, openRun } from './runner';
import { refreshUserMappings, resolveUserMapping } from './stages/users';

/**
 * pnpm cli import:clickup [--dry-run|--delta] [--since <iso>] [--resume] [--placeholders|--skip-unmapped]
 *                         [--no-activity] [--no-attachments] [--no-archived]
 * Runs in the foreground; credentials from Admin → Integrations, else CLICKUP_API_TOKEN / CLICKUP_TEAM_ID.
 */
export const commands: Record<string, (args: string[]) => Promise<void>> = {
  'import:clickup': async (args) => {
    const has = (f: string) => args.includes(f);
    const val = (f: string) => (args.indexOf(f) >= 0 ? args[args.indexOf(f) + 1] : undefined);
    const mode: RunMode = has('--dry-run') ? 'dry_run' : has('--delta') ? 'delta' : 'full';

    if (mode !== 'dry_run' && (has('--placeholders') || has('--skip-unmapped'))) {
      await refreshUserMappings(await createClickUpClient());
      const pending = await db.select().from(importUserMappings).where(eq(importUserMappings.resolution, 'unresolved'));
      for (const p of pending) await resolveUserMapping(p.clickupUserId, has('--skip-unmapped') ? { kind: 'skip' } : { kind: 'placeholder', role: 3 });
      if (pending.length) console.log(`${pending.length} unmapped ClickUp user(s) ${has('--skip-unmapped') ? 'skipped' : 'created as placeholders'}`);
    }

    await createClickUpClient(); // fails fast without credentials
    let run = await openRun();
    if (run && !has('--resume')) throw new Error(`An import is already ${run.status} (${run.id}); pass --resume to continue it, or cancel it in Admin → ClickUp import`);
    if (!run) {
      run = await createRun({
        mode, startedBy: null, since: val('--since') ? new Date(val('--since')!) : null,
        options: { includeActivity: !has('--no-activity'), downloadAttachments: !has('--no-attachments'), includeArchived: !has('--no-archived') },
      });
    }
    console.log(`ClickUp import ${run.mode} ${run.id}`);
    let last = '';
    const timer = setInterval(() => {
      const ctx = activeRun()?.ctx;
      if (!ctx) return;
      const p = ctx.cursor.progress;
      const line = `[${ctx.cursor.stage ? STAGE_LABELS[ctx.cursor.stage as Stage] : '…'}] ${p ? `${p.done}/${p.total}` : ''} ${p?.label ?? ''} · ${ctx.api.stats().requests} API calls`;
      if (line !== last) console.log(line);
      last = line;
    }, 3000);
    await launch(run.id);
    clearInterval(timer);
    const [final] = await db.select().from(importRuns).where(eq(importRuns.id, run.id));
    const v = await runView(final);
    console.log(`\nStatus: ${v.status}${v.error ? ` — ${v.error}` : ''}`);
    if (v.awaitingUserMapping) console.log('Waiting for the user mapping review: resolve users in Admin → ClickUp import (or rerun with --placeholders / --skip-unmapped), then rerun with --resume.');
    for (const [entity, c] of Object.entries(v.stats)) {
      console.log(`  ${entity.padEnd(16)} seen ${c.seen ?? 0}  created ${c.created ?? 0}  updated ${c.updated ?? 0}  unchanged ${c.unchanged ?? 0}  skipped ${c.skipped ?? 0}  failed ${c.failed ?? 0}`);
    }
    console.log(`Issues: ${JSON.stringify(v.issueCounts)} — download the report in Admin → ClickUp import`);
    if (v.validation) console.log(`Validation: ${v.validation.ok ? 'OK' : 'differences found'}`);
    if (v.status === 'failed') process.exitCode = 1;
  },
};
