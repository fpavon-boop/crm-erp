import { runAutomationsTickExclusive } from '@/lib/automations/tick-lock';

export function startScheduler() {
  if (process.env.DISABLE_INTERNAL_SCHEDULER === 'true') return;

  const minutes = Number(process.env.AUTOMATIONS_INTERVAL_MINUTES || 15);
  const globalState = globalThis as unknown as { __crmSchedulerStarted?: boolean };
  if (globalState.__crmSchedulerStarted) return;
  globalState.__crmSchedulerStarted = true;

  // Goes through the shared cross-process lease (SYSTEM_AUDIT.md D4) rather
  // than running the automations+email-sync work directly — if the
  // standalone worker or a Cron-triggered call is already mid-tick, this
  // is a safe, immediate no-op instead of a duplicate run.
  const tick = async () => {
    try {
      await runAutomationsTickExclusive();
    } catch (err) {
      console.error('[scheduler] tick failed:', err);
    }
  };

  setTimeout(tick, 60 * 1000);
  setInterval(tick, minutes * 60 * 1000);
}
