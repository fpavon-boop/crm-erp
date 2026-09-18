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
import { runScheduledAutomations } from '../lib/automations/engine';
import { prisma } from '../lib/prisma';
import { syncEmailAccount } from '../lib/email/imap';

const intervalMinutes = Number(process.env.WORKER_INTERVAL_MINUTES || 15);

async function tick() {
  const startedAt = new Date().toISOString();
  try {
    const results = await runScheduledAutomations();
    console.log(`[worker] ${startedAt} automations:`, results);

    const accounts = await prisma.emailAccount.findMany({ where: { active: true } });
    for (const account of accounts) {
      try {
        const result = await syncEmailAccount(account.id);
        console.log(`[worker] synced ${account.label}:`, result);
      } catch (err) {
        console.error(`[worker] failed to sync ${account.label}:`, err);
      }
    }
  } catch (err) {
    console.error('[worker] tick failed:', err);
  }
}

console.log(`[worker] starting, interval = ${intervalMinutes} minutes`);
tick();
setInterval(tick, intervalMinutes * 60 * 1000);
