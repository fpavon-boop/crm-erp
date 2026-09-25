/**
 * Optional standalone worker process that periodically calls the same
 * automations logic as POST /api/automations/run, without needing an
 * external cron trigger. Useful for docker-compose local dev, or as an
 * Easypanel background service if you prefer this over Easypanel's Cron
 * feature (see README "Automations scheduling").
 *
 * Run with: npm run worker
 * Configure the interval with WORKER_INTERVAL_MINUTES (default 15).
 */
import 'dotenv/config';
import { runAutomationsTickExclusive } from '../lib/automations/tick-lock';

const intervalMinutes = Number(process.env.WORKER_INTERVAL_MINUTES || 15);

// Goes through the shared cross-process lease (SYSTEM_AUDIT.md D4) — if
// the in-process scheduler (running inside the `app` container) or a
// Cron-triggered call is already mid-tick, this is a safe, immediate
// no-op instead of a duplicate run. This is what makes it safe to deploy
// this worker alongside the in-process scheduler at all, which was not
// true before this phase.
async function tick() {
  const startedAt = new Date().toISOString();
  try {
    const result = await runAutomationsTickExclusive();
    if (!result.ranTick) {
      console.log(`[worker] ${startedAt} skipped — another process is already mid-tick`);
      return;
    }
    console.log(`[worker] ${startedAt} automations:`, result.results);
    for (const sync of result.emailSync ?? []) {
      if (sync.error) console.error(`[worker] failed to sync ${sync.account}:`, sync.error);
      else console.log(`[worker] synced ${sync.account}:`, sync);
    }
  } catch (err) {
    console.error('[worker] tick failed:', err);
  }
}

console.log(`[worker] starting, interval = ${intervalMinutes} minutes`);
tick();
setInterval(tick, intervalMinutes * 60 * 1000);
