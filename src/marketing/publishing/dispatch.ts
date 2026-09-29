import { Prisma, type MarketingSchedule } from '@prisma/client';
import { toNumber } from '@/lib/format';
import { redactText } from '@/marketing/security/redaction';
import { evaluateCampaignSafeguards, type SafeguardEvaluation } from '@/marketing/campaigns/safeguard-gate';
import { claimJob, deliverJob, DISPATCH_BACKOFF_MS, DISPATCH_LEASE_MS } from '@/marketing/scheduling/outbound';
import { defaultPublishingDeps, type PublishingDeps } from './deps';
import { buildDispatchPackage, type DispatchPackage } from './packages';
import { buildPostContext, LIVE_CAMPAIGN_STATUSES, signOffProblems, socialPostPhase } from './post-service';

/**
 * Social dispatch — the SOCIAL_PUBLISH half of the unified marketing
 * dispatcher (src/marketing/scheduling/dispatcher.ts).
 *
 * For each due job:
 *  1. Claim it (compare-and-set; a second worker gets nothing).
 *  2. Re-validate EVERYTHING immediately before sending — sign-off still
 *     valid, campaign still live, post/media still valid, and the campaign's
 *     stock + margin safeguards, plus a price-change check against the
 *     snapshot taken at approval. Any BLOCK fails the post (no retry) and
 *     nothing is sent.
 *  3. Build the platform package once and store it (payload + checksum);
 *     every retry re-sends those exact bytes.
 *  4. Deliver it signed via the shared outbound (scheduling/outbound.ts).
 *
 * Double-posting is prevented by the stable idempotency key (n8n dedupes on
 * it) and by recordPublishResult accepting one externalPostId per job.
 */

export { DISPATCH_BACKOFF_MS, DISPATCH_LEASE_MS };

export type DispatchOutcome =
  | { jobId: string; outcome: 'DISPATCHED' | 'RETRY_SCHEDULED' | 'SKIPPED_CLAIMED' | 'CANCELLED_STALE' }
  | { jobId: string; outcome: 'FAILED'; reason: string };

interface PriceDrift {
  productId: string;
  approved: number | null;
  now: number | null;
}

function priceDrift(approved: unknown, current: SafeguardEvaluation | null): PriceDrift[] {
  const snap = approved as SafeguardEvaluation | null;
  if (!snap?.products || !current) return [];
  const before = new Map(snap.products.map((p) => [p.productId, p.margin.listPrice]));
  return current.products
    .map((p) => ({ productId: p.productId, approved: before.get(p.productId) ?? null, now: p.margin.listPrice }))
    .filter((d) => d.approved !== d.now);
}

async function failJob(job: MarketingSchedule, reason: string, deps: PublishingDeps, opts: { failPost: boolean }) {
  const now = deps.now();
  await deps.db.$transaction(async (tx) => {
    await tx.marketingSchedule.updateMany({ where: { id: job.id }, data: { status: 'FAILED', completedAt: now, lastError: redactText(reason).slice(0, 500) } });
    if (opts.failPost && job.socialPostId) {
      await tx.socialPost.updateMany({
        where: { id: job.socialPostId, dispatchJobId: job.id, status: 'SCHEDULED' },
        data: { status: 'FAILED', errorMessage: redactText(reason).slice(0, 500) },
      });
    }
  });
}

/** Re-validation right before sending. Returns BLOCK reasons (empty = OK). */
async function preflight(job: MarketingSchedule, deps: PublishingDeps) {
  const post = job.socialPostId ? await deps.db.socialPost.findUnique({ where: { id: job.socialPostId } }) : null;
  if (!post) return { stale: true as const };
  if (post.dispatchJobId !== job.id || socialPostPhase(post) === 'PUBLISHED' || post.status !== 'SCHEDULED') return { stale: true as const };

  const reasons: string[] = [...(await signOffProblems(post, deps))];
  const ctx = await buildPostContext(post, deps);
  if (ctx.account.status !== 'ACTIVE') reasons.push(`Social account is ${ctx.account.status}`);
  if (!ctx.campaign || !LIVE_CAMPAIGN_STATUSES.has(ctx.campaign.status)) reasons.push('Campaign is no longer approved');
  if (ctx.campaign?.endsAt && ctx.campaign.endsAt < deps.now()) reasons.push('Campaign has ended');
  for (const i of ctx.validation.issues) if (i.severity === 'BLOCK') reasons.push(i.message);

  let evaluation: SafeguardEvaluation | null = null;
  if (ctx.campaign) {
    evaluation = await evaluateCampaignSafeguards(
      ctx.campaign.productIds,
      ctx.campaign.discountPct == null ? null : toNumber(ctx.campaign.discountPct),
      deps.safeguards,
      { now: deps.now }
    );
    if (evaluation.verdict === 'BLOCK') {
      for (const p of evaluation.products) for (const i of [...p.inventory.issues, ...p.margin.issues]) if (i.severity === 'BLOCK') reasons.push(i.message);
      for (const i of evaluation.issues) if (i.severity === 'BLOCK') reasons.push(i.message);
    }
    for (const d of priceDrift(post.safeguardSnapshot, evaluation)) {
      reasons.push(`Price of product ${d.productId} changed since approval (${d.approved} → ${d.now})`);
    }
  }
  return { stale: false as const, post, ctx, reasons };
}

export async function dispatchJob(job: MarketingSchedule, deps: PublishingDeps = defaultPublishingDeps): Promise<DispatchOutcome> {
  const now = deps.now();

  // 1. Claim
  const claim = await claimJob(deps.db, job, now);
  if (!claim.claimed) return { jobId: job.id, outcome: 'SKIPPED_CLAIMED' };

  // 2. Re-validate
  const pre = await preflight(job, deps);
  if (pre.stale) {
    await deps.db.marketingSchedule.updateMany({ where: { id: job.id }, data: { status: 'CANCELLED', completedAt: now, lastError: 'Stale job: post changed or was unscheduled' } });
    return { jobId: job.id, outcome: 'CANCELLED_STALE' };
  }
  if (pre.reasons.length) {
    const reason = `Pre-dispatch check failed: ${pre.reasons.join('; ')}`;
    await failJob(job, reason, deps, { failPost: true });
    return { jobId: job.id, outcome: 'FAILED', reason };
  }

  // 3. Package (built once; reused byte-for-byte on retries)
  let pkg = job.payload as DispatchPackage | null;
  if (!pkg || pkg.checksum !== job.checksum) {
    pkg = buildDispatchPackage({
      jobId: job.id,
      idempotencyKey: job.idempotencyKey ?? job.id,
      platform: pre.ctx.account.platform,
      account: {
        id: pre.ctx.account.id,
        externalAccountId: pre.ctx.account.externalAccountId,
        handle: pre.ctx.account.handle,
        n8nCredentialRef: pre.ctx.account.n8nCredentialRef,
      },
      post: pre.post,
      media: pre.ctx.media,
      resolveAssetUrl: deps.resolveAssetUrl,
      callbackUrl: deps.callbackUrl(),
      createdAt: now,
    });
    await deps.db.marketingSchedule.updateMany({
      where: { id: job.id },
      data: { payload: JSON.parse(JSON.stringify(pkg)) as Prisma.InputJsonValue, checksum: pkg.checksum },
    });
  }

  // 4. Deliver
  const url = deps.webhookUrl();
  if (!url) {
    await failJob(job, 'N8N_MARKETING_WEBHOOK_URL is not configured', deps, { failPost: false });
    return { jobId: job.id, outcome: 'FAILED', reason: 'N8N_MARKETING_WEBHOOK_URL is not configured' };
  }
  const result = await deliverJob(job, claim.attempt, url, pkg, deps);
  if (result.kind === 'DELIVERED') {
    await deps.db.socialPost.updateMany({ where: { id: pre.post.id, dispatchJobId: job.id, status: 'SCHEDULED' }, data: { dispatchedAt: now } });
    return { jobId: job.id, outcome: 'DISPATCHED' };
  }
  if (result.kind === 'RETRY_SCHEDULED') return { jobId: job.id, outcome: 'RETRY_SCHEDULED' };
  await failJob(job, result.reason, deps, { failPost: true });
  return { jobId: job.id, outcome: 'FAILED', reason: result.reason };
}

/** Due PENDING jobs plus DISPATCHED jobs whose ack lease expired. */
export async function dispatchDueSocialPosts(options: { limit?: number } = {}, deps: PublishingDeps = defaultPublishingDeps) {
  const now = deps.now();
  const limit = Math.max(1, Math.min(100, options.limit ?? 25));
  const [due, expired] = await Promise.all([
    deps.db.marketingSchedule.findMany({
      where: { jobType: 'SOCIAL_PUBLISH', status: 'PENDING', runAt: { lte: now } },
      orderBy: { runAt: 'asc' },
      take: limit,
    }),
    deps.db.marketingSchedule.findMany({
      where: { jobType: 'SOCIAL_PUBLISH', status: 'DISPATCHED', dispatchedAt: { lte: new Date(now.getTime() - DISPATCH_LEASE_MS) } },
      take: limit,
    }),
  ]);
  const results: DispatchOutcome[] = [];
  for (const job of [...due, ...expired].slice(0, limit)) {
    // Only re-send an expired lease if n8n never acknowledged the post.
    if (job.status === 'DISPATCHED' && job.socialPostId) {
      const post = await deps.db.socialPost.findUnique({ where: { id: job.socialPostId } });
      if (post?.dispatchedAt) continue;
    }
    results.push(await dispatchJob(job, deps));
  }
  return results;
}
