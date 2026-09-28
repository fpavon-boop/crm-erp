import { z, ZodError } from 'zod';
import { Prisma, type MarketingAsset, type SocialPost } from '@prisma/client';
import { toNumber } from '@/lib/format';
import { DEFAULT_PAGE_SIZE, pageWindow, totalPages } from '@/lib/pagination';
import { canPerform, type MarketingAction } from '@/marketing/security/rbac';
import { marketingErrors, MarketingError } from '@/marketing/errors';
import { redactText } from '@/marketing/security/redaction';
import { evaluateCampaignSafeguards, type SafeguardEvaluation } from '@/marketing/campaigns/safeguard-gate';
import { CampaignSafeguardError } from '@/marketing/campaigns/errors';
import { videoPhase } from '@/marketing/videos/video-service';
import { VIDEO_PLATFORM_RULES } from '@/marketing/videos/platform-rules';
import { defaultPublishingDeps, type PublishingDeps } from './deps';
import { idempotencyKeyFor, jobIdFor, validatePost, type PostMedia } from './packages';

/**
 * SocialPost lifecycle and scheduling.
 *
 * Phases (socialPostPhase):
 *   DRAFT → REVIEW → APPROVED (ADMIN) → SCHEDULED (ADMIN) → DISPATCHED → PUBLISHED
 *                    ↘ REJECTED                       ↘ FAILED → (ADMIN retry) SCHEDULED
 *
 * Publishing gate — a post can be scheduled only when ALL hold:
 * - status APPROVED, approved by an ADMIN who is STILL an active ADMIN,
 *   for the current version (any edit voids approval);
 * - its campaign is APPROVED (or already SCHEDULED/PUBLISHED); linked content
 *   is APPROVED; a linked video render is COMPLETED from an approved version;
 * - the post validates for its platform and the campaign's stock + margin
 *   safeguards do not BLOCK.
 * The dispatcher (dispatch.ts) re-checks all of this again right before
 * sending.
 *
 * ERP access is read-only (safeguards read Product/Stock; the approver check
 * reads User). Writes touch only marketing tables.
 */

export type SocialPostPhase = 'DRAFT' | 'REVIEW' | 'APPROVED' | 'REJECTED' | 'SCHEDULED' | 'DISPATCHED' | 'PUBLISHED' | 'FAILED';

export function socialPostPhase(p: Pick<SocialPost, 'status' | 'dispatchedAt'>): SocialPostPhase {
  switch (p.status) {
    case 'HUMAN_REVIEW':
      return 'REVIEW';
    case 'APPROVED':
    case 'REJECTED':
    case 'PUBLISHED':
    case 'FAILED':
      return p.status;
    case 'SCHEDULED':
      return p.dispatchedAt ? 'DISPATCHED' : 'SCHEDULED';
    default:
      return 'DRAFT';
  }
}

export const LIVE_CAMPAIGN_STATUSES = new Set(['APPROVED', 'SCHEDULED', 'PUBLISHED']);
export const MAX_SCHEDULE_AHEAD_DAYS = 90;

export interface Actor {
  userId: string;
  role: string;
}

function requireAction(actor: Actor, action: MarketingAction) {
  if (!canPerform(actor.role, action)) throw marketingErrors.forbidden(`Role ${actor.role} cannot ${action.replace(/_/g, ' ')} social posts`);
}

function parse<T>(schema: z.ZodType<T, any, unknown>, value: unknown): T {
  try {
    return schema.parse(value);
  } catch (err) {
    if (err instanceof ZodError) throw marketingErrors.invalidInput('Invalid social post input', err.flatten());
    throw err;
  }
}

const json = (v: unknown) => JSON.parse(JSON.stringify(v)) as Prisma.InputJsonValue;
const num = (d: Prisma.Decimal | number | null) => (d == null ? null : toNumber(d));

export function toPostMedia(a: MarketingAsset): PostMedia {
  return {
    id: a.id,
    type: a.type,
    url: a.url,
    mimeType: a.mimeType,
    width: a.width,
    height: a.height,
    sizeBytes: a.sizeBytes,
    durationSec: num(a.durationSec),
    altText: a.altText,
    archivedAt: a.archivedAt,
  };
}

// =============================================================================
// Loading & validation context
// =============================================================================

async function loadMedia(deps: PublishingDeps, ids: string[]) {
  const rows = ids.length ? await deps.db.marketingAsset.findMany({ where: { id: { in: ids } } }) : [];
  const byId = new Map(rows.map((r) => [r.id, r]));
  return {
    media: ids.map((id) => byId.get(id)).filter((a): a is MarketingAsset => Boolean(a)).map(toPostMedia),
    missing: ids.filter((id) => !byId.has(id)),
  };
}

export async function buildPostContext(post: SocialPost, deps: PublishingDeps) {
  const [account, campaign] = await Promise.all([
    deps.db.socialAccount.findUnique({ where: { id: post.socialAccountId } }),
    post.campaignId ? deps.db.marketingCampaign.findUnique({ where: { id: post.campaignId } }) : null,
  ]);
  if (!account) throw marketingErrors.notFound('Social account', post.socialAccountId);
  const brand = await deps.getBrand(campaign?.brandProfileId ?? null);
  const discount = campaign?.discountPct == null ? null : toNumber(campaign.discountPct);
  const { media, missing } = await loadMedia(deps, post.mediaAssetIds);
  const validation = validatePost({
    platform: account.platform,
    caption: post.caption,
    media,
    missingMediaIds: missing,
    brand,
    language: post.language,
    approvedDiscountPct: discount,
    resolveAssetUrl: deps.resolveAssetUrl,
  });
  return { account, campaign, brand, discount, media, validation };
}

/** Everything linked to the post must itself be signed off. */
async function linkedApprovalProblems(post: SocialPost, campaign: { status: string } | null, deps: PublishingDeps): Promise<string[]> {
  const problems: string[] = [];
  if (!campaign) problems.push('Post has no campaign');
  else if (!LIVE_CAMPAIGN_STATUSES.has(campaign.status)) problems.push(`Campaign is ${campaign.status}, not APPROVED`);
  if (post.contentId) {
    const content = await deps.db.marketingContent.findUnique({ where: { id: post.contentId } });
    if (!content || content.status !== 'APPROVED') problems.push(`Linked content is ${content?.status ?? 'missing'}, not APPROVED`);
  }
  if (post.videoProjectId) {
    const video = await deps.db.videoProject.findUnique({ where: { id: post.videoProjectId } });
    if (!video || videoPhase(video) !== 'COMPLETED' || video.approvedVersion !== video.version || !video.outputAssetId) {
      problems.push('Linked video has no completed render of an approved version');
    }
  }
  return problems;
}

async function campaignSafeguards(campaign: { productIds: string[] } | null, discount: number | null, deps: PublishingDeps, stage: string) {
  if (!campaign) return null;
  const evaluation = await evaluateCampaignSafeguards(campaign.productIds, discount, deps.safeguards, { now: deps.now });
  if (evaluation.verdict === 'BLOCK') throw new CampaignSafeguardError(evaluation, stage);
  return evaluation;
}

async function logDecision(
  tx: Prisma.TransactionClient,
  post: SocialPost,
  from: SocialPost['status'],
  to: SocialPost['status'],
  actor: { userId: string },
  extra: { comment?: string | null; evaluation?: SafeguardEvaluation | null; acknowledged?: boolean } = {}
) {
  if (!post.campaignId) return;
  await tx.campaignApproval.create({
    data: {
      campaignId: post.campaignId,
      targetType: 'SOCIAL_POST',
      targetId: post.id,
      fromStatus: from,
      toStatus: to,
      decidedById: actor.userId,
      comment: extra.comment ?? null,
      safeguardVerdict: extra.evaluation?.verdict ?? null,
      safeguardSnapshot: extra.evaluation ? json(extra.evaluation) : Prisma.JsonNull,
      warningsAcknowledged: Boolean(extra.acknowledged),
    },
  });
}

// =============================================================================
// Create / read / edit
// =============================================================================

const createSchema = z
  .object({
    socialAccountId: z.string().trim().min(1),
    campaignId: z.string().trim().min(1),
    contentId: z.string().trim().min(1).optional(),
    videoProjectId: z.string().trim().min(1).optional(),
    mediaAssetIds: z.array(z.string().trim().min(1)).max(10).default([]),
    caption: z.string().trim().max(10_000).optional(),
    language: z.enum(['EN', 'ES']).optional(),
  })
  .strict();

const PLATFORM_FOR_VIDEO = Object.fromEntries(Object.entries(VIDEO_PLATFORM_RULES).map(([k, r]) => [k, r.channel]));

export async function createSocialPost(input: unknown, actor: Actor, deps: PublishingDeps = defaultPublishingDeps) {
  requireAction(actor, 'draft');
  const p = parse(createSchema, input);
  const account = await deps.db.socialAccount.findUnique({ where: { id: p.socialAccountId } });
  if (!account) throw marketingErrors.notFound('Social account', p.socialAccountId);
  if (account.status !== 'ACTIVE') throw marketingErrors.invalidInput(`Social account is ${account.status}`);
  const campaign = await deps.db.marketingCampaign.findUnique({ where: { id: p.campaignId }, select: { id: true } });
  if (!campaign) throw marketingErrors.notFound('Campaign', p.campaignId);

  let caption = p.caption ?? null;
  let language = p.language ?? 'EN';
  const media = [...p.mediaAssetIds];

  if (p.contentId) {
    const content = await deps.db.marketingContent.findUnique({ where: { id: p.contentId } });
    if (!content || content.campaignId !== p.campaignId) throw marketingErrors.invalidInput('Content does not belong to this campaign');
    if (content.type === 'POST_CONCEPT') throw marketingErrors.invalidInput('Post concepts are ideas, not publishable copy');
    if (content.channel !== account.platform) throw marketingErrors.invalidInput(`Content is for ${content.channel}, account is ${account.platform}`);
    caption ??= [content.title, content.body, content.hashtags.join(' ')].filter((s) => s?.trim()).join('\n\n');
    language = p.language ?? (content.language === 'es' ? 'ES' : 'EN');
  }

  if (p.videoProjectId) {
    const video = await deps.db.videoProject.findUnique({ where: { id: p.videoProjectId } });
    if (!video || video.campaignId !== p.campaignId) throw marketingErrors.invalidInput('Video does not belong to this campaign');
    if (PLATFORM_FOR_VIDEO[video.platform] !== account.platform) throw marketingErrors.invalidInput(`Video was made for ${video.platform}`);
    if (videoPhase(video) !== 'COMPLETED' || !video.outputAssetId) throw marketingErrors.invalidInput('Video has no completed render yet');
    if (!media.includes(video.outputAssetId)) media.unshift(video.outputAssetId);
  }

  return deps.db.socialPost.create({
    data: {
      socialAccountId: account.id,
      campaignId: p.campaignId,
      contentId: p.contentId ?? null,
      videoProjectId: p.videoProjectId ?? null,
      mediaAssetIds: media,
      caption,
      language,
      status: 'DRAFT',
      createdById: actor.userId,
    },
  });
}

export async function getSocialPost(id: string, actor: Actor, deps: PublishingDeps = defaultPublishingDeps) {
  requireAction(actor, 'view');
  const post = await deps.db.socialPost.findUnique({ where: { id } });
  if (!post) throw marketingErrors.notFound('Social post', id);
  const ctx = await buildPostContext(post, deps);
  return { post, phase: socialPostPhase(post), validation: ctx.validation };
}

const listSchema = z
  .object({
    campaignId: z.string().optional(),
    socialAccountId: z.string().optional(),
    status: z.enum(['DRAFT', 'AI_GENERATED', 'HUMAN_REVIEW', 'APPROVED', 'REJECTED', 'SCHEDULED', 'PUBLISHED', 'FAILED']).optional(),
    page: z.number().int().min(1).default(1),
    pageSize: z.number().int().min(1).max(100).default(DEFAULT_PAGE_SIZE),
  })
  .strict();

export async function listSocialPosts(query: z.input<typeof listSchema>, actor: Actor, deps: PublishingDeps = defaultPublishingDeps) {
  requireAction(actor, 'view');
  const q = parse(listSchema, query);
  const where: Prisma.SocialPostWhereInput = {
    ...(q.campaignId ? { campaignId: q.campaignId } : {}),
    ...(q.socialAccountId ? { socialAccountId: q.socialAccountId } : {}),
    ...(q.status ? { status: q.status } : {}),
  };
  const [items, total] = await Promise.all([
    deps.db.socialPost.findMany({ where, orderBy: { scheduledFor: 'asc' }, ...pageWindow(q.page, q.pageSize) }),
    deps.db.socialPost.count({ where }),
  ]);
  return { items: items.map((p) => ({ ...p, phase: socialPostPhase(p) })), total, page: q.page, pageSize: q.pageSize, totalPages: totalPages(total, q.pageSize) };
}

const patchSchema = z
  .object({
    caption: z.string().trim().max(10_000).nullable().optional(),
    mediaAssetIds: z.array(z.string().trim().min(1)).max(10).optional(),
    language: z.enum(['EN', 'ES']).optional(),
  })
  .strict();

/** Edits bump `version`, return the post to DRAFT and void any approval.
 * Scheduled posts must be unscheduled first; dispatched/published are locked. */
export async function updateSocialPost(id: string, patch: unknown, actor: Actor, deps: PublishingDeps = defaultPublishingDeps) {
  requireAction(actor, 'draft');
  const p = parse(patchSchema, patch);
  const post = await deps.db.socialPost.findUnique({ where: { id } });
  if (!post) throw marketingErrors.notFound('Social post', id);
  const phase = socialPostPhase(post);
  if (phase === 'SCHEDULED') throw marketingErrors.invalidState('Unschedule the post before editing it');
  if (phase === 'DISPATCHED' || phase === 'PUBLISHED') throw marketingErrors.invalidState(`A ${phase} post cannot be edited`);

  return deps.db.$transaction(async (tx) => {
    const { count } = await tx.socialPost.updateMany({
      where: { id, version: post.version, status: post.status },
      data: {
        ...p,
        version: { increment: 1 },
        status: 'DRAFT',
        approvedVersion: null,
        approvedById: null,
        approvedAt: null,
        safeguardSnapshot: Prisma.JsonNull,
        errorMessage: null,
      },
    });
    if (count !== 1) throw marketingErrors.invalidState(`Social post ${id} changed concurrently; reload and retry`);
    if (post.status !== 'DRAFT') await logDecision(tx, post, post.status, 'DRAFT', actor, { comment: 'Edited — approval cleared' });
    return tx.socialPost.findUnique({ where: { id } });
  });
}

// =============================================================================
// Review / approval
// =============================================================================

const TRANSITIONS: Partial<Record<SocialPostPhase, Partial<Record<'REVIEW' | 'APPROVED' | 'REJECTED' | 'DRAFT', MarketingAction>>>> = {
  DRAFT: { REVIEW: 'submit_for_review' },
  REVIEW: { APPROVED: 'approve', REJECTED: 'reject', DRAFT: 'draft' },
  APPROVED: { DRAFT: 'draft' },
  REJECTED: { DRAFT: 'draft' },
  FAILED: { DRAFT: 'draft' },
};

export async function transitionSocialPost(
  id: string,
  to: 'REVIEW' | 'APPROVED' | 'REJECTED' | 'DRAFT',
  actor: Actor,
  options: { comment?: string; acknowledgeWarnings?: boolean } = {},
  deps: PublishingDeps = defaultPublishingDeps
) {
  const post = await deps.db.socialPost.findUnique({ where: { id } });
  if (!post) throw marketingErrors.notFound('Social post', id);
  const from = socialPostPhase(post);
  const action = TRANSITIONS[from]?.[to];
  if (!action) throw marketingErrors.invalidState(`Cannot move a social post from ${from} to ${to}`);
  requireAction(actor, action);
  const comment = options.comment?.trim() || null;
  if (to === 'REJECTED' && !comment) throw marketingErrors.invalidInput('A rejection requires a comment');

  let evaluation: SafeguardEvaluation | null = null;
  let compliance: unknown = undefined;
  if (to === 'REVIEW' || to === 'APPROVED') {
    const ctx = await buildPostContext(post, deps);
    compliance = ctx.validation;
    if (ctx.validation.verdict === 'BLOCK') {
      const blocks = ctx.validation.issues.filter((i) => i.severity === 'BLOCK');
      throw marketingErrors.unprocessable('POST_INVALID', blocks.map((b) => b.message).join('; '), blocks);
    }
    if (to === 'APPROVED') {
      const problems = await linkedApprovalProblems(post, ctx.campaign, deps);
      if (problems.length) throw marketingErrors.unprocessable('LINKED_NOT_APPROVED', problems.join('; '), problems);
      evaluation = await campaignSafeguards(ctx.campaign, ctx.discount, deps, 'post approval');
      const warned = ctx.validation.verdict === 'WARN' || evaluation?.verdict === 'WARN';
      if (warned && !options.acknowledgeWarnings) {
        throw new MarketingError('WARNINGS_NOT_ACKNOWLEDGED', 'Warnings must be acknowledged before approval.', 422, {
          post: ctx.validation.issues,
          safeguards: evaluation,
        });
      }
    }
  }

  const status = to === 'REVIEW' ? 'HUMAN_REVIEW' : to;
  return deps.db.$transaction(async (tx) => {
    const { count } = await tx.socialPost.updateMany({
      where: { id, version: post.version, status: post.status },
      data: {
        status,
        ...(compliance !== undefined ? { compliance: json(compliance) } : {}),
        ...(to === 'APPROVED'
          ? { approvedVersion: post.version, approvedById: actor.userId, approvedAt: deps.now(), safeguardSnapshot: evaluation ? json(evaluation) : Prisma.JsonNull }
          : { approvedVersion: null, approvedById: null, approvedAt: null }),
        ...(to === 'DRAFT' ? { dispatchJobId: null, dispatchedAt: null, errorMessage: null } : {}),
      },
    });
    if (count !== 1) throw marketingErrors.invalidState(`Social post ${id} changed concurrently; reload and retry`);
    await logDecision(tx, post, post.status, status, actor, {
      comment,
      evaluation,
      acknowledged: Boolean(options.acknowledgeWarnings && to === 'APPROVED'),
    });
    return tx.socialPost.findUnique({ where: { id } });
  });
}

// =============================================================================
// Scheduling (idempotent)
// =============================================================================

/** Shared by schedule and the dispatcher: is the sign-off still valid? */
export async function signOffProblems(post: SocialPost, deps: PublishingDeps): Promise<string[]> {
  const problems: string[] = [];
  if (!post.approvedById || !post.approvedAt) problems.push('Post has no ADMIN sign-off');
  else if (post.approvedVersion !== post.version) problems.push('Post changed after approval');
  else if (!(await deps.isActiveAdmin(post.approvedById))) problems.push('Approver is no longer an active ADMIN');
  return problems;
}

const scheduleSchema = z.object({ scheduledFor: z.coerce.date() }).strict();

export async function schedulePost(id: string, input: unknown, actor: Actor, deps: PublishingDeps = defaultPublishingDeps) {
  requireAction(actor, 'schedule');
  const { scheduledFor } = parse(scheduleSchema, input);
  const post = await deps.db.socialPost.findUnique({ where: { id } });
  if (!post) throw marketingErrors.notFound('Social post', id);

  const key = idempotencyKeyFor(post.id, post.version, post.dispatchGeneration);
  const jobId = jobIdFor(key);

  // Idempotent replay: this exact version/generation is already scheduled.
  if (post.dispatchJobId === jobId) {
    const job = await deps.db.marketingSchedule.findUnique({ where: { id: jobId } });
    return { post, job, created: false };
  }

  const phase = socialPostPhase(post);
  if (phase !== 'APPROVED') throw marketingErrors.invalidState(`Only APPROVED posts can be scheduled; this one is ${phase}`);
  const signOff = await signOffProblems(post, deps);
  if (signOff.length) throw marketingErrors.unprocessable('SIGN_OFF_INVALID', signOff.join('; '), signOff);

  const now = deps.now();
  if (scheduledFor.getTime() < now.getTime() - 60_000) throw marketingErrors.invalidInput('scheduledFor is in the past');
  if (scheduledFor.getTime() > now.getTime() + MAX_SCHEDULE_AHEAD_DAYS * 86_400_000) {
    throw marketingErrors.invalidInput(`scheduledFor must be within ${MAX_SCHEDULE_AHEAD_DAYS} days`);
  }

  const ctx = await buildPostContext(post, deps);
  const campaign = ctx.campaign;
  if (!campaign || !LIVE_CAMPAIGN_STATUSES.has(campaign.status)) throw marketingErrors.invalidState('Campaign is not approved');
  if (campaign.startsAt && scheduledFor < campaign.startsAt) throw marketingErrors.invalidInput('scheduledFor is before the campaign starts');
  if (campaign.endsAt && scheduledFor > campaign.endsAt) throw marketingErrors.invalidInput('scheduledFor is after the campaign ends');
  if (ctx.validation.verdict === 'BLOCK') throw marketingErrors.unprocessable('POST_INVALID', 'Post no longer validates', ctx.validation.issues);
  const evaluation = await campaignSafeguards(campaign, ctx.discount, deps, 'scheduling');

  try {
    return await deps.db.$transaction(async (tx) => {
      let existing = await tx.marketingSchedule.findUnique({ where: { id: jobId } });
      if (existing?.status === 'CANCELLED') {
        // Same version re-scheduled after an unschedule: reuse the job id and
        // key (nothing was ever sent), just re-arm it.
        await tx.marketingSchedule.updateMany({
          where: { id: jobId, status: 'CANCELLED' },
          data: { status: 'PENDING', runAt: scheduledFor, attempt: 0, lastError: null, completedAt: null, dispatchedAt: null },
        });
        existing = await tx.marketingSchedule.findUnique({ where: { id: jobId } });
      } else if (existing && existing.status !== 'PENDING') {
        throw marketingErrors.invalidState(`Job ${jobId} is already ${existing.status}; use retry for failed posts`);
      }
      const job =
        existing ??
        (await tx.marketingSchedule.create({
          data: {
            id: jobId,
            idempotencyKey: key,
            jobType: 'SOCIAL_PUBLISH',
            status: 'PENDING',
            runAt: scheduledFor,
            campaignId: post.campaignId,
            socialPostId: post.id,
            n8nWorkflow: 'social-publish',
          },
        }));
      const { count } = await tx.socialPost.updateMany({
        where: { id, version: post.version, status: 'APPROVED' },
        data: { status: 'SCHEDULED', scheduledFor, dispatchJobId: jobId, dispatchedAt: null },
      });
      if (count !== 1) throw marketingErrors.invalidState(`Social post ${id} changed concurrently; reload and retry`);
      await logDecision(tx, post, 'APPROVED', 'SCHEDULED', actor, { comment: `Scheduled for ${scheduledFor.toISOString()} (job ${jobId})`, evaluation });
      return { post: await tx.socialPost.findUnique({ where: { id } }), job, created: !existing };
    });
  } catch (err) {
    // A concurrent identical request won the race (unique job id / status
    // compare-and-set): return its result instead of an error.
    const again = await deps.db.socialPost.findUnique({ where: { id } });
    if (again?.dispatchJobId === jobId) {
      return { post: again, job: await deps.db.marketingSchedule.findUnique({ where: { id: jobId } }), created: false };
    }
    throw err;
  }
}

/** Change the time of a not-yet-dispatched post (same job, same key). */
export async function reschedulePost(id: string, input: unknown, actor: Actor, deps: PublishingDeps = defaultPublishingDeps) {
  requireAction(actor, 'schedule');
  const { scheduledFor } = parse(scheduleSchema, input);
  const post = await deps.db.socialPost.findUnique({ where: { id } });
  if (!post) throw marketingErrors.notFound('Social post', id);
  if (socialPostPhase(post) !== 'SCHEDULED' || !post.dispatchJobId) throw marketingErrors.invalidState('Only scheduled, not-yet-dispatched posts can be rescheduled');
  if (scheduledFor.getTime() < deps.now().getTime() - 60_000) throw marketingErrors.invalidInput('scheduledFor is in the past');
  return deps.db.$transaction(async (tx) => {
    const { count } = await tx.marketingSchedule.updateMany({ where: { id: post.dispatchJobId!, status: 'PENDING' }, data: { runAt: scheduledFor } });
    if (count !== 1) throw marketingErrors.invalidState('The job is already being dispatched');
    await tx.socialPost.updateMany({ where: { id, dispatchJobId: post.dispatchJobId }, data: { scheduledFor } });
    return tx.socialPost.findUnique({ where: { id } });
  });
}

/** Cancel a not-yet-dispatched post back to APPROVED. */
export async function unschedulePost(id: string, actor: Actor, deps: PublishingDeps = defaultPublishingDeps) {
  requireAction(actor, 'schedule');
  const post = await deps.db.socialPost.findUnique({ where: { id } });
  if (!post) throw marketingErrors.notFound('Social post', id);
  if (socialPostPhase(post) !== 'SCHEDULED' || !post.dispatchJobId) throw marketingErrors.invalidState('Only scheduled, not-yet-dispatched posts can be unscheduled');
  return deps.db.$transaction(async (tx) => {
    const { count } = await tx.marketingSchedule.updateMany({ where: { id: post.dispatchJobId!, status: 'PENDING' }, data: { status: 'CANCELLED', completedAt: deps.now() } });
    if (count !== 1) throw marketingErrors.invalidState('The job is already being dispatched');
    await tx.socialPost.updateMany({
      where: { id, dispatchJobId: post.dispatchJobId },
      data: { status: 'APPROVED', scheduledFor: null, dispatchJobId: null },
    });
    await logDecision(tx, post, 'SCHEDULED', 'APPROVED', actor, { comment: 'Unscheduled' });
    return tx.socialPost.findUnique({ where: { id } });
  });
}

/** After a FAILED result: a NEW generation → new job id and key, so the
 * failed attempt can never be confused with the retry. */
export async function retryFailedPost(id: string, input: unknown, actor: Actor, deps: PublishingDeps = defaultPublishingDeps) {
  requireAction(actor, 'schedule');
  const post = await deps.db.socialPost.findUnique({ where: { id } });
  if (!post) throw marketingErrors.notFound('Social post', id);
  if (socialPostPhase(post) !== 'FAILED') throw marketingErrors.invalidState('Only FAILED posts can be retried');
  const { count } = await deps.db.socialPost.updateMany({
    where: { id, status: 'FAILED', dispatchGeneration: post.dispatchGeneration },
    data: { status: 'APPROVED', dispatchGeneration: { increment: 1 }, dispatchJobId: null, dispatchedAt: null, errorMessage: null },
  });
  if (count !== 1) throw marketingErrors.invalidState(`Social post ${id} changed concurrently; reload and retry`);
  return schedulePost(id, input, actor, deps);
}

// =============================================================================
// Publish result (system; called by the authenticated n8n callback handler)
// =============================================================================

const resultSchema = z
  .object({
    jobId: z.string().min(1),
    status: z.enum(['PUBLISHED', 'FAILED']),
    externalPostId: z.string().trim().min(1).max(200).optional(),
    permalink: z.string().url().max(2048).optional(),
    error: z.string().max(5000).optional(),
  })
  .strict()
  .refine((r) => r.status !== 'PUBLISHED' || r.externalPostId, { message: 'PUBLISHED requires externalPostId', path: ['externalPostId'] });

export type PublishResultOutcome =
  | { applied: true; phase: SocialPostPhase }
  | { applied: false; reason: 'UNKNOWN_JOB' | 'STALE_JOB' | 'DUPLICATE' | 'ALREADY_FINAL' | 'CONFLICTING_EXTERNAL_ID'; phase?: SocialPostPhase };

export async function recordPublishResult(event: unknown, deps: PublishingDeps = defaultPublishingDeps): Promise<PublishResultOutcome> {
  const e = parse(resultSchema, event);
  const job = await deps.db.marketingSchedule.findUnique({ where: { id: e.jobId } });
  if (!job?.socialPostId) return { applied: false, reason: 'UNKNOWN_JOB' };
  const post = await deps.db.socialPost.findUnique({ where: { id: job.socialPostId } });
  if (!post) return { applied: false, reason: 'UNKNOWN_JOB' };
  const phase = socialPostPhase(post);
  if (post.dispatchJobId !== e.jobId) return { applied: false, reason: 'STALE_JOB', phase };

  if (post.status === 'PUBLISHED') {
    if (e.status === 'PUBLISHED' && e.externalPostId === post.externalPostId) return { applied: false, reason: 'DUPLICATE', phase };
    if (e.status === 'PUBLISHED') {
      // A second, different platform post for one job = a double post upstream.
      console.error(`[marketing-publish] job ${e.jobId} reported a second externalPostId (${e.externalPostId}) after ${post.externalPostId}`);
      return { applied: false, reason: 'CONFLICTING_EXTERNAL_ID', phase };
    }
    return { applied: false, reason: 'ALREADY_FINAL', phase };
  }
  if (post.status === 'FAILED' && e.status === 'FAILED') return { applied: false, reason: 'DUPLICATE', phase };
  if (post.status !== 'SCHEDULED') return { applied: false, reason: 'ALREADY_FINAL', phase };

  const now = deps.now();
  await deps.db.$transaction(async (tx) => {
    const { count } = await tx.socialPost.updateMany({
      where: { id: post.id, dispatchJobId: e.jobId, status: 'SCHEDULED' },
      data:
        e.status === 'PUBLISHED'
          ? { status: 'PUBLISHED', externalPostId: e.externalPostId, permalink: e.permalink ?? null, publishedAt: now, errorMessage: null }
          : { status: 'FAILED', errorMessage: redactText(e.error ?? 'Publishing failed').slice(0, 500) },
    });
    if (count !== 1) throw marketingErrors.invalidState('Post changed concurrently');
    await tx.marketingSchedule.updateMany({
      where: { id: e.jobId },
      data: {
        status: e.status === 'PUBLISHED' ? 'COMPLETED' : 'FAILED',
        completedAt: now,
        result: json({ status: e.status, externalPostId: e.externalPostId ?? null, permalink: e.permalink ?? null }),
        lastError: e.status === 'FAILED' ? redactText(e.error ?? '').slice(0, 500) : null,
      },
    });
  });
  return { applied: true, phase: e.status };
}
