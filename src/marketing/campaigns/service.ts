import { z, ZodError } from 'zod';
import { Prisma, type MarketingApprovalStatus } from '@prisma/client';
import { authorizeTransition, canPerform } from '@/marketing/security/rbac';
import { validateCopy } from '@/marketing/content/terminology';
import { toNumber } from '@/lib/format';
import { DEFAULT_PAGE_SIZE, pageWindow, totalPages } from '@/lib/pagination';
import { MARKETING_CHANNELS } from '@/marketing/ai/prompt-templates';
import { evaluateCampaignSafeguards, type SafeguardEvaluation } from './safeguard-gate';
import { CampaignSafeguardError, campaignErrors } from './errors';
import { defaultCampaignDeps, type CampaignEngineDeps } from './engine';

/**
 * Campaign lifecycle services: query, edit, status transitions, delete.
 *
 * Callers (API routes) must still gate with requireMarketingAction(), which
 * re-checks ADMIN from the DB; these services independently enforce the
 * role policy and state machine from src/marketing/security/rbac.ts so a
 * mis-wired route can't approve or publish.
 *
 * Invariants:
 * - Every transition is an optimistic compare-and-set on the current status
 *   (concurrent reviewers can't both win) and writes a CampaignApproval row.
 * - APPROVED / SCHEDULED / PUBLISHED re-run the stock + margin safeguards;
 *   BLOCK refuses, WARN needs explicit acknowledgement to approve.
 * - Approval is refused while any content has blocking compliance findings.
 * - Any edit to a campaign or its content sends it back to DRAFT and clears
 *   the approval. SCHEDULED / PUBLISHED campaigns are not editable.
 */

export interface Actor {
  userId: string;
  role: string;
}

const LOCKED: ReadonlySet<MarketingApprovalStatus> = new Set(['SCHEDULED', 'PUBLISHED']);
const SAFEGUARDED: ReadonlySet<MarketingApprovalStatus> = new Set(['APPROVED', 'SCHEDULED', 'PUBLISHED']);

/** Which content statuses follow a campaign transition to `to`. */
const CONTENT_CASCADE: Partial<Record<MarketingApprovalStatus, MarketingApprovalStatus[]>> = {
  HUMAN_REVIEW: ['DRAFT', 'AI_GENERATED', 'REJECTED'],
  APPROVED: ['HUMAN_REVIEW'],
  REJECTED: ['HUMAN_REVIEW'],
  DRAFT: ['AI_GENERATED', 'HUMAN_REVIEW', 'APPROVED', 'REJECTED'],
};

const json = (v: unknown) => JSON.parse(JSON.stringify(v)) as Prisma.InputJsonValue;

function parse<T>(schema: z.ZodType<T, any, unknown>, value: unknown): T {
  try {
    return schema.parse(value);
  } catch (err) {
    if (err instanceof ZodError) throw campaignErrors.invalidInput('Invalid input', err.flatten());
    throw err;
  }
}

function requireRole(actor: Actor, action: 'view' | 'draft') {
  if (!canPerform(actor.role, action)) throw campaignErrors.forbidden(`Role ${actor.role} cannot ${action} campaigns`);
}

const campaignInclude = {
  contents: { orderBy: [{ variantGroupId: 'asc' }, { language: 'asc' }] },
  approvals: { orderBy: { createdAt: 'desc' } },
} satisfies Prisma.MarketingCampaignInclude;

// =============================================================================
// Queries
// =============================================================================

export async function getCampaign(id: string, actor: Actor, deps: CampaignEngineDeps = defaultCampaignDeps) {
  requireRole(actor, 'view');
  const campaign = await deps.db.marketingCampaign.findUnique({ where: { id }, include: campaignInclude });
  if (!campaign) throw campaignErrors.notFound('Campaign', id);
  return campaign;
}

const listSchema = z.object({
  status: z.enum(['DRAFT', 'AI_GENERATED', 'HUMAN_REVIEW', 'APPROVED', 'REJECTED', 'SCHEDULED', 'PUBLISHED', 'FAILED']).optional(),
  channel: z.enum(MARKETING_CHANNELS).optional(),
  search: z.string().trim().max(100).optional(),
  page: z.number().int().min(1).default(1),
  pageSize: z.number().int().min(1).max(100).default(DEFAULT_PAGE_SIZE),
});

export async function listCampaigns(query: z.input<typeof listSchema>, actor: Actor, deps: CampaignEngineDeps = defaultCampaignDeps) {
  requireRole(actor, 'view');
  const q = parse(listSchema, query);
  const where: Prisma.MarketingCampaignWhereInput = {
    ...(q.status ? { status: q.status } : {}),
    ...(q.channel ? { channels: { has: q.channel } } : {}),
    ...(q.search ? { name: { contains: q.search, mode: 'insensitive' } } : {}),
  };
  const [items, total] = await Promise.all([
    deps.db.marketingCampaign.findMany({ where, orderBy: { updatedAt: 'desc' }, ...pageWindow(q.page, q.pageSize) }),
    deps.db.marketingCampaign.count({ where }),
  ]);
  return { items, total, page: q.page, pageSize: q.pageSize, totalPages: totalPages(total, q.pageSize) };
}

// =============================================================================
// Transitions
// =============================================================================

export interface TransitionOptions {
  comment?: string;
  acknowledgeWarnings?: boolean;
}

export async function transitionCampaignStatus(
  id: string,
  to: MarketingApprovalStatus,
  actor: Actor,
  options: TransitionOptions = {},
  deps: CampaignEngineDeps = defaultCampaignDeps
) {
  const campaign = await deps.db.marketingCampaign.findUnique({ where: { id }, include: { contents: true } });
  if (!campaign) throw campaignErrors.notFound('Campaign', id);
  const from = campaign.status;

  const check = authorizeTransition(actor.role, from, to);
  if (!check.ok) {
    throw check.reason === 'FORBIDDEN'
      ? campaignErrors.forbidden(`Role ${actor.role} cannot move a campaign from ${from} to ${to}`)
      : campaignErrors.invalidState(`Cannot move a campaign from ${from} to ${to}`);
  }
  const comment = options.comment?.trim() || null;
  if (to === 'REJECTED' && !comment) throw campaignErrors.invalidInput('A rejection requires a comment');

  let evaluation: SafeguardEvaluation | null = null;
  if (SAFEGUARDED.has(to)) {
    evaluation = await evaluateCampaignSafeguards(
      campaign.productIds,
      campaign.discountPct == null ? null : toNumber(campaign.discountPct),
      deps.safeguards,
      { now: deps.now }
    );
    if (evaluation.verdict === 'BLOCK') throw new CampaignSafeguardError(evaluation, `transition to ${to}`);
    if (to === 'APPROVED' && evaluation.verdict === 'WARN' && !options.acknowledgeWarnings) {
      throw campaignErrors.warningsNotAcknowledged(evaluation);
    }
  }

  if (to === 'APPROVED') {
    const blocked = campaign.contents
      .filter((c) => (c.compliance as { verdict?: string } | null)?.verdict === 'BLOCK')
      .map((c) => ({ contentId: c.id, channel: c.channel, language: c.language }));
    if (blocked.length) throw campaignErrors.complianceBlocked(blocked);
  }

  const now = deps.now();
  return deps.db.$transaction(async (tx) => {
    const data: Prisma.MarketingCampaignUpdateManyMutationInput = { status: to };
    if (to === 'APPROVED') Object.assign(data, { approvedById: actor.userId, approvedAt: now });
    if (to === 'DRAFT' || to === 'REJECTED') Object.assign(data, { approvedById: null, approvedAt: null });
    if (evaluation) data.safeguardSnapshot = json(evaluation);

    const { count } = await tx.marketingCampaign.updateMany({ where: { id, status: from }, data });
    if (count !== 1) throw campaignErrors.conflict(`Campaign ${id} changed status concurrently; reload and retry`);

    const cascadeFrom = CONTENT_CASCADE[to];
    if (cascadeFrom) {
      await tx.marketingContent.updateMany({
        where: { campaignId: id, status: { in: cascadeFrom } },
        data: {
          status: to,
          ...(to === 'APPROVED' || to === 'REJECTED'
            ? { reviewedById: actor.userId, reviewedAt: now, rejectionReason: to === 'REJECTED' ? comment : null }
            : {}),
        },
      });
    }

    await tx.campaignApproval.create({
      data: {
        campaignId: id,
        targetType: 'CAMPAIGN',
        targetId: id,
        fromStatus: from,
        toStatus: to,
        decidedById: actor.userId,
        comment,
        safeguardVerdict: evaluation?.verdict ?? null,
        safeguardSnapshot: evaluation ? json(evaluation) : Prisma.JsonNull,
        warningsAcknowledged: Boolean(options.acknowledgeWarnings && evaluation?.verdict === 'WARN'),
      },
    });

    return tx.marketingCampaign.findUnique({ where: { id }, include: campaignInclude });
  });
}

// =============================================================================
// Edits
// =============================================================================

const detailsSchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    objective: z.string().trim().max(500).nullable().optional(),
    description: z.string().trim().max(5000).nullable().optional(),
    channels: z.array(z.enum(MARKETING_CHANNELS)).min(1).max(6).optional(),
    startsAt: z.coerce.date().nullable().optional(),
    endsAt: z.coerce.date().nullable().optional(),
    budget: z.number().positive().max(10_000_000).nullable().optional(),
    discountPct: z.number().min(0).max(99).nullable().optional(),
    productIds: z.array(z.string().trim().min(1)).max(20).optional(),
  })
  .strict()
  .refine((p) => !(p.startsAt && p.endsAt) || p.endsAt > p.startsAt, { message: 'endsAt must be after startsAt', path: ['endsAt'] });

/** Returns campaign to DRAFT (clearing approval) if it wasn't already. */
async function revertToDraft(
  tx: Prisma.TransactionClient,
  campaign: { id: string; status: MarketingApprovalStatus },
  actor: Actor,
  reason: string
) {
  if (campaign.status === 'DRAFT') return;
  await tx.marketingContent.updateMany({
    where: { campaignId: campaign.id, status: { in: CONTENT_CASCADE.DRAFT! } },
    data: { status: 'DRAFT' },
  });
  await tx.campaignApproval.create({
    data: {
      campaignId: campaign.id,
      targetType: 'CAMPAIGN',
      targetId: campaign.id,
      fromStatus: campaign.status,
      toStatus: 'DRAFT',
      decidedById: actor.userId,
      comment: reason,
      safeguardSnapshot: Prisma.JsonNull,
    },
  });
}

export async function updateCampaignDetails(
  id: string,
  patch: unknown,
  actor: Actor,
  deps: CampaignEngineDeps = defaultCampaignDeps
) {
  requireRole(actor, 'draft');
  const p = parse(detailsSchema, patch);
  const campaign = await deps.db.marketingCampaign.findUnique({ where: { id } });
  if (!campaign) throw campaignErrors.notFound('Campaign', id);
  if (LOCKED.has(campaign.status)) throw campaignErrors.invalidState(`A ${campaign.status} campaign cannot be edited`);

  let evaluation: SafeguardEvaluation | null = null;
  if (p.productIds !== undefined || p.discountPct !== undefined) {
    const productIds = p.productIds ?? campaign.productIds;
    const discount = p.discountPct !== undefined ? p.discountPct : campaign.discountPct == null ? null : toNumber(campaign.discountPct);
    evaluation = await evaluateCampaignSafeguards(productIds, discount, deps.safeguards, { now: deps.now });
    if (evaluation.verdict === 'BLOCK') throw new CampaignSafeguardError(evaluation, 'edit');
  }

  return deps.db.$transaction(async (tx) => {
    const { count } = await tx.marketingCampaign.updateMany({
      where: { id, status: campaign.status },
      data: {
        ...p,
        status: 'DRAFT',
        approvedById: null,
        approvedAt: null,
        ...(evaluation ? { safeguardSnapshot: json(evaluation) } : {}),
      },
    });
    if (count !== 1) throw campaignErrors.conflict(`Campaign ${id} changed concurrently; reload and retry`);
    await revertToDraft(tx, campaign, actor, 'Edited — approval cleared');
    return tx.marketingCampaign.findUnique({ where: { id }, include: campaignInclude });
  });
}

const contentPatchSchema = z
  .object({
    title: z.string().trim().max(200).nullable().optional(),
    body: z.string().trim().min(1).max(10000).optional(),
    hashtags: z.array(z.string().trim().regex(/^#[\p{L}\p{N}_]{1,60}$/u)).max(30).optional(),
  })
  .strict();

/** Human edit of one content row: re-runs terminology/compliance, marks it
 * human-authored, and sends the content and its campaign back to DRAFT. */
export async function updateCampaignContent(
  contentId: string,
  patch: unknown,
  actor: Actor,
  deps: CampaignEngineDeps = defaultCampaignDeps
) {
  requireRole(actor, 'draft');
  const p = parse(contentPatchSchema, patch);
  const content = await deps.db.marketingContent.findUnique({ where: { id: contentId }, include: { campaign: true } });
  if (!content) throw campaignErrors.notFound('Content', contentId);
  const campaign = content.campaign;
  if (LOCKED.has(campaign.status) || content.status === 'PUBLISHED') {
    throw campaignErrors.invalidState(`Content of a ${campaign.status} campaign cannot be edited`);
  }

  const brand = await deps.getBrand(campaign.brandProfileId);
  if (!brand) throw campaignErrors.brandRequired();

  const title = p.title !== undefined ? p.title : content.title;
  const body = p.body ?? content.body;
  const hashtags = p.hashtags ?? content.hashtags;
  const validation = validateCopy([title, body, hashtags.join(' ')].filter(Boolean).join('\n\n'), {
    brand,
    language: content.language === 'es' ? 'ES' : 'EN',
    channel: content.channel,
    approvedDiscountPct: campaign.discountPct == null ? null : toNumber(campaign.discountPct),
    checkDisclaimer: content.type !== 'POST_CONCEPT',
  });
  const compliance = {
    verdict: validation.verdict,
    findings: validation.issues.length
      ? [{ path: content.language, language: content.language.toUpperCase(), issues: validation.issues.map(({ code, severity, message, suggestion }) => ({ code, severity, message, suggestion })) }]
      : [],
  };

  return deps.db.$transaction(async (tx) => {
    if (campaign.status !== 'DRAFT') {
      const { count } = await tx.marketingCampaign.updateMany({
        where: { id: campaign.id, status: campaign.status },
        data: { status: 'DRAFT', approvedById: null, approvedAt: null },
      });
      if (count !== 1) throw campaignErrors.conflict(`Campaign ${campaign.id} changed concurrently; reload and retry`);
      await revertToDraft(tx, campaign, actor, `Content ${contentId} edited — approval cleared`);
    }
    const updated = await tx.marketingContent.update({
      where: { id: contentId },
      data: {
        title,
        body,
        hashtags,
        status: 'DRAFT',
        aiGenerated: false,
        reviewedById: null,
        reviewedAt: null,
        rejectionReason: null,
        version: { increment: 1 },
        compliance: json(compliance),
      },
    });
    return { content: updated, compliance };
  });
}

/** Only never-reviewed DRAFT campaigns can be deleted; anything with an
 * approval history is kept for the audit trail. */
export async function deleteDraftCampaign(id: string, actor: Actor, deps: CampaignEngineDeps = defaultCampaignDeps) {
  requireRole(actor, 'draft');
  const campaign = await deps.db.marketingCampaign.findUnique({ where: { id } });
  if (!campaign) throw campaignErrors.notFound('Campaign', id);
  if (campaign.status !== 'DRAFT') throw campaignErrors.invalidState('Only DRAFT campaigns can be deleted');
  const history = await deps.db.campaignApproval.count({ where: { campaignId: id } });
  if (history > 0) throw campaignErrors.invalidState('Campaign has review history and cannot be deleted');
  await deps.db.marketingCampaign.delete({ where: { id } });
}

/** Read-only: current stock + margin safeguard evaluation for a campaign. */
export async function getCampaignSafeguards(id: string, actor: Actor, deps: CampaignEngineDeps = defaultCampaignDeps) {
  requireRole(actor, 'view');
  const campaign = await deps.db.marketingCampaign.findUnique({ where: { id }, select: { productIds: true, discountPct: true } });
  if (!campaign) throw campaignErrors.notFound('Campaign', id);
  return evaluateCampaignSafeguards(campaign.productIds, campaign.discountPct == null ? null : toNumber(campaign.discountPct), deps.safeguards, { now: deps.now });
}
