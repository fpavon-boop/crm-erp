import { prisma } from '@/lib/prisma';
import type { AutomationJobStatus } from '@prisma/client';

/**
 * The standardized automation execution contract (Phase 13,
 * docs/AUTOMATION_SYSTEM.md): every built-in scheduled job and the
 * WooCommerce sync run through this one wrapper, which guarantees a job's
 * trigger/conditions/action, status (PENDING→RUNNING→COMPLETED/FAILED),
 * start/finish timestamps, and — critically — the error message *and
 * stack trace* are always captured, never swallowed. This wraps existing
 * job logic; it does not change what any job does or when it runs.
 *
 * Retries ride the natural scheduler cadence rather than a new queue/
 * scheduling engine (deliberately — see "Do not create uncontrolled
 * automation" in docs/AUTOMATION_SYSTEM.md): `attempt`/`maxAttempts` are
 * tracked per (jobKey, entityType, entityId) so a job that keeps failing
 * for the same entity stops being retried automatically after
 * `maxAttempts` consecutive failures and is left in a terminal FAILED
 * state for a human to see in the admin view, instead of retrying forever
 * silently.
 */
export interface RunAutomationJobOptions {
  jobKey: string;
  trigger: string;
  conditions?: unknown;
  action?: string;
  entityType?: string;
  entityId?: string;
  maxAttempts?: number;
}

export interface AutomationJobResult<T> {
  status: AutomationJobStatus;
  result?: T;
  error?: string;
}

/** How many consecutive prior FAILED runs exist for this exact
 * (jobKey, entityType, entityId) since the last COMPLETED one — the basis
 * for "stop retrying after maxAttempts." A job with no entityType/entityId
 * (a whole-batch job like checkOverdueInvoices itself, not one invoice)
 * always attempt 1 — per-entity backoff only applies where there is a
 * specific entity to track repeated failures against. */
async function priorConsecutiveFailures(jobKey: string, entityType?: string, entityId?: string): Promise<number> {
  if (!entityType || !entityId) return 0;
  const lastCompleted = await prisma.automationJobRun.findFirst({
    where: { jobKey, entityType, entityId, status: 'COMPLETED' },
    orderBy: { createdAt: 'desc' },
    select: { createdAt: true },
  });
  return prisma.automationJobRun.count({
    where: {
      jobKey,
      entityType,
      entityId,
      // RETRYING counts too — it's an unsuccessful attempt awaiting the
      // next one, not a success. Counting only the terminal FAILED status
      // here would let a job stuck alternating RETRYING forever never
      // actually reach attempt >= maxAttempts.
      status: { in: ['FAILED', 'RETRYING'] },
      ...(lastCompleted ? { createdAt: { gt: lastCompleted.createdAt } } : {}),
    },
  });
}

export async function runAutomationJob<T>(opts: RunAutomationJobOptions, fn: () => Promise<T>): Promise<AutomationJobResult<T>> {
  const maxAttempts = opts.maxAttempts ?? 1;
  const priorFailures = await priorConsecutiveFailures(opts.jobKey, opts.entityType, opts.entityId);
  const attempt = priorFailures + 1;

  if (attempt > maxAttempts) {
    // Already exhausted — do not attempt again, do not write a new row;
    // the last FAILED run (visible in the admin view) already records why.
    return { status: 'FAILED', error: `Exceeded maxAttempts (${maxAttempts}) — not retrying.` };
  }

  const run = await prisma.automationJobRun.create({
    data: {
      jobKey: opts.jobKey,
      trigger: opts.trigger,
      conditions: opts.conditions !== undefined ? (opts.conditions as never) : undefined,
      action: opts.action,
      entityType: opts.entityType,
      entityId: opts.entityId,
      attempt,
      maxAttempts,
      status: 'RUNNING',
      startedAt: new Date(),
    },
  });

  try {
    const result = await fn();
    await prisma.automationJobRun.update({
      where: { id: run.id },
      data: { status: 'COMPLETED', finishedAt: new Date() },
    });
    return { status: 'COMPLETED', result };
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    const errorStack = err instanceof Error ? err.stack ?? null : null;
    const status: AutomationJobStatus = attempt < maxAttempts ? 'RETRYING' : 'FAILED';
    await prisma.automationJobRun.update({
      where: { id: run.id },
      data: { status, errorMessage, errorStack, finishedAt: new Date() },
    });
    return { status, error: errorMessage };
  }
}
