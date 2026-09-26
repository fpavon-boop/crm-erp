import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';

/**
 * The one shared "don't do this twice" primitive (Phase 13, automation
 * system hardening — SYSTEM_AUDIT.md-adjacent, docs/AUTOMATION_SYSTEM.md).
 * Generalizes the exact concurrency pattern already established in
 * src/lib/automations/tick-lock.ts: a plain `create()` INSERT racing on a
 * unique column is the most fundamental guarantee Postgres offers, so a
 * second caller with the same key always loses the race cleanly instead
 * of both succeeding.
 *
 * `resultRef` lets a caller that generated a real result on the winning
 * claim (e.g. a CommunicationLog id) record it, so a retried/duplicate
 * caller can look up and return that same result instead of silently
 * doing nothing — the difference between "safe no-op" and "safe no-op
 * that still tells the caller what happened."
 */
export interface IdempotencyClaim {
  /** True if this call is the first to use this key — the caller should
   * proceed with the side effect. False means another call already
   * claimed it; `existingResultRef` (if the winner recorded one via
   * recordIdempotentResult) is the prior outcome to return instead. */
  claimed: boolean;
  existingResultRef: string | null;
}

export async function claimIdempotencyKey(key: string, scope: string): Promise<IdempotencyClaim> {
  try {
    await prisma.idempotencyKey.create({ data: { key, scope } });
    return { claimed: true, existingResultRef: null };
  } catch (err) {
    if (!(err instanceof Prisma.PrismaClientKnownRequestError) || err.code !== 'P2002') throw err;
    const existing = await prisma.idempotencyKey.findUnique({ where: { key } });
    return { claimed: false, existingResultRef: existing?.resultRef ?? null };
  }
}

/** Records what the winning claim actually produced, so a later duplicate
 * call (see `existingResultRef` above) can return it. Best-effort: if this
 * fails for some reason, the claim itself still stood — the duplicate
 * caller just won't get a `resultRef` back, and treats it as a no-op with
 * no result to report, which is still correct/safe. */
export async function recordIdempotentResult(key: string, resultRef: string): Promise<void> {
  await prisma.idempotencyKey.update({ where: { key }, data: { resultRef } }).catch(() => undefined);
}
