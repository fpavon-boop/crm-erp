import crypto from 'crypto';
import { Prisma } from '@prisma/client';
import type { prisma } from '@/lib/prisma';

/**
 * Marketing-owned lease lock (MarketingLock), deliberately separate from
 * the core ScheduledTickLock so a slow n8n call can never delay ERP
 * automations and vice versa. A lease older than `leaseMs` is treated as
 * free (self-heals if a worker crashes mid-tick). Release only clears the
 * lock if this run still owns it.
 */

type LockDb = Pick<typeof prisma, 'marketingLock'>;

export async function acquireMarketingLock(db: LockDb, id: string, leaseMs: number, now: Date): Promise<string | null> {
  const runId = crypto.randomUUID();
  const { count } = await db.marketingLock.updateMany({
    where: { id, OR: [{ lockedAt: null }, { lockedAt: { lt: new Date(now.getTime() - leaseMs) } }] },
    data: { lockedAt: now, runId },
  });
  if (count === 1) return runId;
  try {
    await db.marketingLock.create({ data: { id, lockedAt: now, runId } });
    return runId;
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') return null;
    if ((err as { code?: string }).code === 'P2002') return null;
    throw err;
  }
}

export async function releaseMarketingLock(db: LockDb, id: string, runId: string): Promise<void> {
  await db.marketingLock.updateMany({ where: { id, runId }, data: { lockedAt: null, runId: null } });
}
