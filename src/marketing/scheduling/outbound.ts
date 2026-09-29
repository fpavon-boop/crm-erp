import type { MarketingSchedule, Prisma } from '@prisma/client';
import { canonicalJson } from '@/marketing/videos/payload';
import { JOB_ID_HEADER, SIGNATURE_HEADER, TIMESTAMP_HEADER, signWebhook } from '@/marketing/security/signing';
import { redactText } from '@/marketing/security/redaction';

/**
 * Shared outbound delivery for every MarketingSchedule job type (social
 * publish, video render): canonical body, HMAC signature, stable job id and
 * idempotency key headers, and one retry policy.
 *
 * Delivery is at-least-once; the stored body is byte-identical on every
 * attempt, and n8n must dedupe on X-Mkt-Job-Id / Idempotency-Key.
 */

export const IDEMPOTENCY_HEADER = 'idempotency-key';
export const DISPATCH_BACKOFF_MS = [60_000, 5 * 60_000, 15 * 60_000];
/** A DISPATCHED job with no acknowledgement after this is re-sent. */
export const DISPATCH_LEASE_MS = 10 * 60_000;

export function signedJobRequest(body: unknown, jobId: string, idempotencyKey: string, secret: string, nowMs: number) {
  const raw = canonicalJson(body);
  const { timestamp, signature } = signWebhook(raw, secret, nowMs);
  return {
    body: raw,
    headers: {
      'content-type': 'application/json',
      [SIGNATURE_HEADER]: signature,
      [TIMESTAMP_HEADER]: timestamp,
      [JOB_ID_HEADER]: jobId,
      [IDEMPOTENCY_HEADER]: idempotencyKey,
    },
  };
}

export interface DeliveryDeps {
  db: { marketingSchedule: Pick<Prisma.MarketingScheduleDelegate, 'updateMany'> };
  send(req: { url: string; headers: Record<string, string>; body: string }): Promise<{ status: number }>;
  signingSecret(): string;
  now(): Date;
}

export type DeliveryResult = { kind: 'DELIVERED' } | { kind: 'RETRY_SCHEDULED' } | { kind: 'FAILED'; reason: string };

/** Sends one already-claimed job. On retryable failure re-arms the job
 * (PENDING + backoff); on final failure returns FAILED for the caller to
 * apply its domain-specific failure handling. */
export async function deliverJob(
  job: Pick<MarketingSchedule, 'id' | 'idempotencyKey' | 'maxAttempts'>,
  attempt: number,
  url: string,
  body: unknown,
  deps: DeliveryDeps
): Promise<DeliveryResult> {
  const now = deps.now();
  const req = signedJobRequest(body, job.id, job.idempotencyKey ?? job.id, deps.signingSecret(), now.getTime());

  let status: number;
  try {
    status = (await deps.send({ url, headers: req.headers, body: req.body })).status;
  } catch (err) {
    status = 0;
    await deps.db.marketingSchedule.updateMany({ where: { id: job.id }, data: { lastError: redactText(String(err)).slice(0, 500) } });
  }

  // 409 = n8n already has this job id/key: treat as delivered.
  if ((status >= 200 && status < 300) || status === 409) return { kind: 'DELIVERED' };

  const retryable = status === 0 || status === 408 || status === 429 || status >= 500;
  if (retryable && attempt < job.maxAttempts) {
    const delay = DISPATCH_BACKOFF_MS[Math.min(attempt - 1, DISPATCH_BACKOFF_MS.length - 1)];
    await deps.db.marketingSchedule.updateMany({
      where: { id: job.id },
      data: { status: 'PENDING', runAt: new Date(now.getTime() + delay), lastError: `n8n responded ${status || 'network error'}` },
    });
    return { kind: 'RETRY_SCHEDULED' };
  }
  return { kind: 'FAILED', reason: `n8n dispatch failed (${status || 'network error'}) after ${attempt} attempt(s)` };
}

/** Claim a job for this worker (compare-and-set on status + attempt). */
export async function claimJob(
  db: { marketingSchedule: Pick<Prisma.MarketingScheduleDelegate, 'updateMany'> },
  job: Pick<MarketingSchedule, 'id' | 'status' | 'attempt' | 'dispatchedAt'>,
  now: Date
): Promise<{ claimed: false } | { claimed: true; attempt: number }> {
  const leaseExpired = job.status === 'DISPATCHED' && job.dispatchedAt != null && now.getTime() - job.dispatchedAt.getTime() > DISPATCH_LEASE_MS;
  if (job.status !== 'PENDING' && !leaseExpired) return { claimed: false };
  const { count } = await db.marketingSchedule.updateMany({
    where: { id: job.id, status: job.status, attempt: job.attempt },
    data: { status: 'DISPATCHED', dispatchedAt: now, attempt: { increment: 1 } },
  });
  return count === 1 ? { claimed: true, attempt: job.attempt + 1 } : { claimed: false };
}
