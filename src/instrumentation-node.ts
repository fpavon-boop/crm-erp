import { runScheduledAutomations } from '@/lib/automations/engine';
import { syncEmailAccount } from '@/lib/email/imap';
import { prisma } from '@/lib/prisma';

export function startScheduler() {
  if (process.env.DISABLE_INTERNAL_SCHEDULER === 'true') return;

  const minutes = Number(process.env.AUTOMATIONS_INTERVAL_MINUTES || 15);
  const globalState = globalThis as unknown as { __crmSchedulerStarted?: boolean };
  if (globalState.__crmSchedulerStarted) return;
  globalState.__crmSchedulerStarted = true;

  const tick = async () => {
    try {
      await runScheduledAutomations();
      const accounts = await prisma.emailAccount.findMany({ where: { active: true } });
      for (const account of accounts) {
        await syncEmailAccount(account.id).catch((err) =>
          console.error(`[scheduler] email sync failed for ${account.label}:`, err)
        );
      }
    } catch (err) {
      console.error('[scheduler] tick failed:', err);
    }
  };

  setTimeout(tick, 60 * 1000);
  setInterval(tick, minutes * 60 * 1000);
}
