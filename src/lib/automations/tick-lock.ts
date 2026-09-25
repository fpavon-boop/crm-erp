import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { runScheduledAutomations } from '@/lib/automations/engine';
import { syncEmailAccount } from '@/lib/email/imap';
import crypto from 'crypto';

const LOCK_ID = 'automations-tick';
/** How long a claim is honored before it's considered abandoned (the
 * process that took it crashed, or is stuck) and the next caller is
 * allowed to reclaim it. Generous relative to how long a real tick
 * (automations + a handful of IMAP syncs) should ever take. */
const LEASE_MINUTES = 10;

/**
 * Claims the single, well-known automations-tick lease. The lock *is* a
 * row: "the lease is free" is represented as "no `ScheduledTickLock` row
 * with this id exists," and claiming it is a plain `create()` keyed by
 * that fixed id — two concurrent attempts to `create()` the same primary
 * key is exactly the scenario Postgres's primary-key uniqueness
 * constraint exists to make airtight: at most one `INSERT` ever succeeds,
 * full stop.
 *
 * The only path that needs a conditional `UPDATE` instead is reclaiming
 * an *abandoned* lease (the row exists, but is older than
 * `LEASE_MINUTES` — the process that created it crashed without
 * releasing it).
 */
async function claimTick(): Promise<{ claimed: boolean; runId: string }> {
  const runId = crypto.randomUUID();

  try {
    await prisma.scheduledTickLock.create({ data: { id: LOCK_ID, lockedAt: new Date(), runId } });
    return { claimed: true, runId };
  } catch (err) {
    if (!(err instanceof Prisma.PrismaClientKnownRequestError) || err.code !== 'P2002') {
      throw err;
    }
  }

  // A row already exists — the lease is currently held. Only take it over
  // if that claim has gone stale (abandoned by a crashed process).
  const staleBefore = new Date(Date.now() - LEASE_MINUTES * 60 * 1000);
  const result = await prisma.scheduledTickLock.updateMany({
    where: { id: LOCK_ID, lockedAt: { lt: staleBefore } },
    data: { lockedAt: new Date(), runId },
  });
  return { claimed: result.count > 0, runId };
}

/** Releases the lease by deleting the row, but only if it's still held by
 * this exact run — never clears a lease a *different* run has since
 * claimed (e.g. because this one's lease went stale and was reclaimed
 * while it was still finishing up). */
async function releaseTick(runId: string): Promise<void> {
  await prisma.scheduledTickLock.deleteMany({ where: { id: LOCK_ID, runId } });
}

export interface AutomationsWorkResult {
  results: Awaited<ReturnType<typeof runScheduledAutomations>>;
  emailSync: Array<{ account: string; error?: string; [key: string]: unknown }>;
}

/** The real work a tick does once it holds the lease: run the scheduled
 * automations, then sync every active email account. Separated out so
 * tests can substitute a different (e.g. artificially slow) function to
 * reliably exercise genuine overlap between two concurrent claims — the
 * real automations pass against a small mailbox list is fast enough that
 * two `runAutomationsTickExclusive()` calls fired at the same instant can
 * legitimately run one after another (claim → work → release, then claim
 * again) rather than actually overlapping, which correctly satisfies the
 * "never two ticks running at once" guarantee but doesn't exercise the
 * contention path deterministically in a test. */
async function runTickWork(): Promise<AutomationsWorkResult> {
  const results = await runScheduledAutomations();

  const accounts = await prisma.emailAccount.findMany({ where: { active: true } });
  const emailSync: AutomationsWorkResult['emailSync'] = [];
  for (const account of accounts) {
    try {
      const result = await syncEmailAccount(account.id);
      emailSync.push({ account: account.label, ...result });
    } catch (err) {
      emailSync.push({ account: account.label, error: String(err) });
    }
  }

  return { results, emailSync };
}

export interface AutomationsTickResult {
  /** False when another process already holds the lease — this call did
   * nothing (not even a partial run) and the caller should just move on;
   * whichever process holds the lease will cover this interval. */
  ranTick: boolean;
  results?: AutomationsWorkResult['results'];
  emailSync?: AutomationsWorkResult['emailSync'];
}

/**
 * The single entry point every automations trigger in this app should call
 * — the in-process scheduler, the optional standalone worker, and the
 * manual/Cron-triggered `POST /api/automations/run` route (SYSTEM_AUDIT.md
 * D4). Runs the real tick work (automations + email sync) only if this
 * call actually won the lease; otherwise returns immediately with
 * `ranTick: false`. This is what makes it safe for all three trigger
 * mechanisms to be active at once (today only one ever is, but nothing
 * enforced that before this phase) without ever letting two ticks' work
 * run at the same time.
 *
 * `work` defaults to the real automations+email-sync pass and should never
 * be overridden in production code — it exists purely so
 * `tests/automations-tick-lock.test.ts` can substitute an artificially
 * slow stand-in to reliably create genuine overlap between two concurrent
 * calls (see `runTickWork`'s doc comment for why that's otherwise hard to
 * exercise deterministically).
 */
export async function runAutomationsTickExclusive(
  work: () => Promise<AutomationsWorkResult> = runTickWork
): Promise<AutomationsTickResult> {
  const { claimed, runId } = await claimTick();
  if (!claimed) return { ranTick: false };

  try {
    const { results, emailSync } = await work();
    return { ranTick: true, results, emailSync };
  } finally {
    await releaseTick(runId);
  }
}
