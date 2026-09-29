import type { MarketingSchedule } from '@prisma/client';
import { redactText } from '@/marketing/security/redaction';
import { defaultPublishingDeps, type PublishingDeps } from '@/marketing/publishing/deps';
import { LIVE_CAMPAIGN_STATUSES } from '@/marketing/publishing/post-service';
import type { DispatchOutcome } from '@/marketing/publishing/dispatch';
import type { RenderPayload } from '@/marketing/videos/payload';
import { claimJob, deliverJob, DISPATCH_LEASE_MS } from './outbound';

/**
 * VIDEO_RENDER half of the unified dispatcher. The render payload was
 * assembled, checksummed and stored when an ADMIN started the render
 * (videos/video-service.ts startRender); here it is re-validated and
 * delivered, signed, byte-identical on every attempt.
 *
 * Acknowledgement is the n8n `render.started` callback (renderStatus leaves
 * QUEUED); until then an expired lease is re-sent with the same bytes.
 */

async function failRender(job: MarketingSchedule, projectId: string | null, reason: string, deps: PublishingDeps) {
  const now = deps.now();
  const msg = redactText(reason).slice(0, 500);
  await deps.db.$transaction(async (tx) => {
    await tx.marketingSchedule.updateMany({ where: { id: job.id }, data: { status: 'FAILED', completedAt: now, lastError: msg } });
    if (projectId) {
      await tx.videoProject.updateMany({ where: { id: projectId, externalJobId: job.id, renderStatus: 'QUEUED' }, data: { renderStatus: 'FAILED', errorMessage: msg } });
    }
  });
}

export async function dispatchVideoJob(job: MarketingSchedule, deps: PublishingDeps = defaultPublishingDeps): Promise<DispatchOutcome> {
  const now = deps.now();
  const claim = await claimJob(deps.db, job, now);
  if (!claim.claimed) return { jobId: job.id, outcome: 'SKIPPED_CLAIMED' };

  const project = await deps.db.videoProject.findFirst({ where: { externalJobId: job.id } });
  if (!project || project.renderStatus !== 'QUEUED') {
    await deps.db.marketingSchedule.updateMany({ where: { id: job.id }, data: { status: 'CANCELLED', completedAt: now, lastError: 'Stale job: project no longer waiting on this render' } });
    return { jobId: job.id, outcome: 'CANCELLED_STALE' };
  }

  // Re-validate the human gate right before handing off.
  const reasons: string[] = [];
  if (project.status !== 'APPROVED' || !project.approvedById || project.approvedVersion !== project.version) reasons.push('Project version is not ADMIN-approved');
  else if (!(await deps.isActiveAdmin(project.approvedById))) reasons.push('Approver is no longer an active ADMIN');
  if (project.campaignId) {
    const campaign = await deps.db.marketingCampaign.findUnique({ where: { id: project.campaignId }, select: { status: true } });
    if (!campaign || !LIVE_CAMPAIGN_STATUSES.has(campaign.status)) reasons.push('Campaign is no longer approved');
  }
  const payload = job.payload as RenderPayload | null;
  if (!payload || !job.checksum || payload.checksum !== job.checksum) reasons.push('Stored render payload is missing or corrupt');
  if (reasons.length) {
    const reason = `Pre-dispatch check failed: ${reasons.join('; ')}`;
    await failRender(job, project.id, reason, deps);
    return { jobId: job.id, outcome: 'FAILED', reason };
  }

  const url = (deps.videoWebhookUrl ?? defaultPublishingDeps.videoWebhookUrl)?.();
  if (!url) {
    const reason = 'N8N_MARKETING_WEBHOOK_URL is not configured';
    await failRender(job, project.id, reason, deps);
    return { jobId: job.id, outcome: 'FAILED', reason };
  }

  const result = await deliverJob(job, claim.attempt, url, payload, deps);
  if (result.kind === 'DELIVERED') return { jobId: job.id, outcome: 'DISPATCHED' };
  if (result.kind === 'RETRY_SCHEDULED') return { jobId: job.id, outcome: 'RETRY_SCHEDULED' };
  await failRender(job, project.id, result.reason, deps);
  return { jobId: job.id, outcome: 'FAILED', reason: result.reason };
}

export async function dispatchDueVideoRenders(options: { limit?: number } = {}, deps: PublishingDeps = defaultPublishingDeps) {
  const now = deps.now();
  const limit = Math.max(1, Math.min(100, options.limit ?? 10));
  const [due, expired] = await Promise.all([
    deps.db.marketingSchedule.findMany({ where: { jobType: 'VIDEO_RENDER', status: 'PENDING', runAt: { lte: now } }, orderBy: { runAt: 'asc' }, take: limit }),
    deps.db.marketingSchedule.findMany({
      where: { jobType: 'VIDEO_RENDER', status: 'DISPATCHED', dispatchedAt: { lte: new Date(now.getTime() - DISPATCH_LEASE_MS) } },
      take: limit,
    }),
  ]);
  const results: DispatchOutcome[] = [];
  for (const job of [...due, ...expired].slice(0, limit)) {
    if (job.status === 'DISPATCHED') {
      const project = await deps.db.videoProject.findFirst({ where: { externalJobId: job.id }, select: { renderStatus: true } });
      if (project?.renderStatus !== 'QUEUED') continue; // n8n acknowledged (render.started or later)
    }
    results.push(await dispatchVideoJob(job, deps));
  }
  return results;
}
