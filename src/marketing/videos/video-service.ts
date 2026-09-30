import crypto from 'crypto';
import { z, ZodError } from 'zod';
import { Prisma, type VideoProject, type VideoScene } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { toNumber } from '@/lib/format';
import { DEFAULT_PAGE_SIZE, pageWindow, totalPages } from '@/lib/pagination';
import { canPerform, type MarketingAction } from '@/marketing/security/rbac';
import { marketingErrors, MarketingError } from '@/marketing/errors';
import { redactText } from '@/marketing/security/redaction';
import type { BrandContext } from '@/marketing/content/brand-profile';
import type { PlaceholderDeclaration, PlaceholderValue } from '@/marketing/templates/placeholders';
import { defaultCampaignDeps, type ProductSnapshot } from '@/marketing/campaigns/engine';
import { evaluateCampaignSafeguards, defaultSafeguardChecks, type SafeguardChecks, type SafeguardEvaluation } from '@/marketing/campaigns/safeguard-gate';
import { CampaignSafeguardError } from '@/marketing/campaigns/errors';
import { VIDEO_PLATFORM_RULES, SCENE_LIMITS, validateVideoProject, type VideoValidation } from './platform-rules';
import { changedAssignments, planInsert, planMove, planRemove, planReorder, SequenceError, type SequencedScene } from './sequence';
import { assembleRenderPayload, PayloadAssemblyError, type PayloadAsset, type RenderPayload } from './payload';
import { resolvePublicAssetUrl } from '@/marketing/assets/signed-urls';

/**
 * Video projects and their scene sequences.
 *
 * Lifecycle (derived by videoPhase() from status + renderStatus):
 *
 *   DRAFT ─submit─▶ REVIEW ─approve (ADMIN)─▶ APPROVED ─startRender (ADMIN)─▶ RENDERING ─▶ COMPLETED
 *     ▲               │ reject (ADMIN) ▶ REJECTED                               │
 *     └──── edit / withdraw ◀──────────────────────────────── FAILED ◀────────┘ (retry → RENDERING)
 *
 * Human approval gate: rendering requires status APPROVED by an ADMIN for
 * the CURRENT version. Any scene/project edit bumps `version`, returns the
 * project to DRAFT and voids the approval, so what renders is exactly what
 * was approved. RENDERING and COMPLETED projects are locked.
 *
 * Submitting and approving re-run the platform/sequence/compliance
 * validator (BLOCK refuses; WARN needs acknowledgement to approve). Approving
 * and rendering also re-run the campaign's stock + margin safeguards.
 *
 * startRender() does not call n8n: it assembles the payload and queues it in
 * the MarketingSchedule outbox (VIDEO_RENDER) for the dispatcher.
 */

export type VideoPhase = 'DRAFT' | 'REVIEW' | 'APPROVED' | 'REJECTED' | 'RENDERING' | 'COMPLETED' | 'FAILED';

export function videoPhase(p: Pick<VideoProject, 'status' | 'renderStatus'>): VideoPhase {
  if (p.renderStatus === 'QUEUED' || p.renderStatus === 'RENDERING') return 'RENDERING';
  if (p.renderStatus === 'COMPLETED') return 'COMPLETED';
  if (p.renderStatus === 'FAILED') return 'FAILED';
  if (p.status === 'HUMAN_REVIEW') return 'REVIEW';
  if (p.status === 'APPROVED') return 'APPROVED';
  if (p.status === 'REJECTED') return 'REJECTED';
  return 'DRAFT';
}

const LOCKED: ReadonlySet<VideoPhase> = new Set(['RENDERING', 'COMPLETED']);

type VideoDb = Pick<
  typeof prisma,
  'videoProject' | 'videoScene' | 'marketingAsset' | 'marketingTemplate' | 'marketingCampaign' | 'campaignApproval' | 'marketingSchedule' | '$transaction'
>;

export interface VideoDeps {
  db: VideoDb;
  safeguards: SafeguardChecks;
  getBrand(brandProfileId?: string | null): Promise<BrandContext | null>;
  loadProduct(id: string): Promise<ProductSnapshot | null>;
  resolveAssetUrl?: (asset: PayloadAsset) => string | null;
  newId(): string;
  now(): Date;
}

export const defaultVideoDeps: VideoDeps = {
  db: prisma,
  safeguards: defaultSafeguardChecks,
  getBrand: defaultCampaignDeps.getBrand,
  loadProduct: defaultCampaignDeps.loadProduct,
  resolveAssetUrl: (a) => resolvePublicAssetUrl(a),
  newId: defaultCampaignDeps.newId,
  now: () => new Date(),
};

export interface Actor {
  userId: string;
  role: string;
}

function requireAction(actor: Actor, action: MarketingAction) {
  if (!canPerform(actor.role, action)) throw marketingErrors.forbidden(`Role ${actor.role} cannot ${action.replace(/_/g, ' ')} video projects`);
}

function parse<T>(schema: z.ZodType<T, any, unknown>, value: unknown): T {
  try {
    return schema.parse(value);
  } catch (err) {
    if (err instanceof ZodError) throw marketingErrors.invalidInput('Invalid video input', err.flatten());
    throw err;
  }
}

const json = (v: unknown) => JSON.parse(JSON.stringify(v)) as Prisma.InputJsonValue;
const num = (d: Prisma.Decimal | number | null) => (d == null ? null : toNumber(d));

// =============================================================================
// Schemas
// =============================================================================

const PLATFORMS = ['TIKTOK', 'INSTAGRAM_REELS', 'FACEBOOK_REELS'] as const;

const boxSchema = z
  .object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1), width: z.number().gt(0).max(1), height: z.number().gt(0).max(1) })
  .strict();

const sceneFields = {
  durationSec: z.number().min(SCENE_LIMITS.minDurationSec).max(SCENE_LIMITS.maxDurationSec).multipleOf(0.01),
  visualCue: z.string().trim().max(1000).nullable().optional(),
  onScreenText: z.string().trim().max(300).nullable().optional(),
  voiceover: z.string().trim().max(2000).nullable().optional(),
  script: z.string().trim().max(2000).nullable().optional(),
  assetId: z.string().trim().min(1).nullable().optional(),
  productId: z.string().trim().min(1).nullable().optional(),
  textPosition: z.enum(['TOP', 'CENTER', 'BOTTOM']).nullable().optional(),
  textBox: boxSchema.nullable().optional(),
  transition: z.enum(['CUT', 'FADE', 'SLIDE', 'ZOOM']).optional(),
};

const sceneCreateSchema = z.object(sceneFields).strict();
const scenePatchSchema = z.object({ ...sceneFields, durationSec: sceneFields.durationSec.optional() }).strict();

const projectCreateSchema = z
  .object({
    campaignId: z.string().trim().min(1),
    title: z.string().trim().min(1).max(120),
    platform: z.enum(PLATFORMS).default('TIKTOK'),
    language: z.enum(['EN', 'ES']).default('EN'),
    targetDurationSec: z.number().int().min(1).max(600).nullable().optional(),
    templateId: z.string().trim().min(1).nullable().optional(),
    audioAssetId: z.string().trim().min(1).nullable().optional(),
    script: z.string().trim().max(5000).nullable().optional(),
  })
  .strict();

const projectPatchSchema = projectCreateSchema.omit({ campaignId: true }).partial().strict();

// =============================================================================
// Reference checks
// =============================================================================

async function checkTargetDuration(platform: (typeof PLATFORMS)[number], target: number | null | undefined) {
  const max = VIDEO_PLATFORM_RULES[platform].maxDurationSec;
  if (target != null && target > max) throw marketingErrors.invalidInput(`targetDurationSec ${target}s exceeds ${VIDEO_PLATFORM_RULES[platform].label}'s ${max}s maximum`);
}

async function checkTemplate(db: VideoDb | Prisma.TransactionClient, templateId: string | null | undefined, platform: (typeof PLATFORMS)[number]) {
  if (!templateId) return;
  const t = await db.marketingTemplate.findUnique({ where: { id: templateId } });
  if (!t) throw marketingErrors.notFound('Template', templateId);
  if (t.kind !== 'VIDEO') throw marketingErrors.invalidInput(`Template ${templateId} is a ${t.kind} template, not VIDEO`);
  if (!t.active) throw marketingErrors.invalidInput(`Template ${templateId} is inactive`);
  if (t.channel !== VIDEO_PLATFORM_RULES[platform].channel) {
    throw marketingErrors.invalidInput(`Template is for ${t.channel}; ${VIDEO_PLATFORM_RULES[platform].label} needs ${VIDEO_PLATFORM_RULES[platform].channel}`);
  }
}

async function checkAsset(db: VideoDb | Prisma.TransactionClient, assetId: string | null | undefined, allowed: string[]) {
  if (!assetId) return;
  const a = await db.marketingAsset.findUnique({ where: { id: assetId } });
  if (!a) throw marketingErrors.notFound('Asset', assetId);
  if (a.archivedAt) throw marketingErrors.invalidInput(`Asset ${assetId} is archived`);
  if (!allowed.includes(a.type)) throw marketingErrors.invalidInput(`Asset ${assetId} is ${a.type}; expected ${allowed.join(' or ')}`);
}

// =============================================================================
// Create / read
// =============================================================================

export async function createVideoProject(input: unknown, actor: Actor, deps: VideoDeps = defaultVideoDeps) {
  requireAction(actor, 'draft');
  const p = parse(projectCreateSchema, input);
  const campaign = await deps.db.marketingCampaign.findUnique({ where: { id: p.campaignId }, select: { id: true } });
  if (!campaign) throw marketingErrors.notFound('Campaign', p.campaignId);
  await checkTargetDuration(p.platform, p.targetDurationSec);
  await checkTemplate(deps.db, p.templateId, p.platform);
  await checkAsset(deps.db, p.audioAssetId, ['AUDIO']);
  return deps.db.videoProject.create({
    data: {
      ...p,
      aspectRatio: VIDEO_PLATFORM_RULES[p.platform].aspectRatios[0],
      status: 'DRAFT',
      renderStatus: 'NOT_STARTED',
      createdById: actor.userId,
    },
  });
}

/** Storyboard output of the Phase 6 `video_storyboard` template. */
export interface StoryboardLike {
  title: string;
  totalDurationSec: number;
  scenes: Array<{
    order: number;
    durationSec: number;
    visual: string;
    onScreenText: { en: string; es: string };
    voiceover: { en: string; es: string } | null;
  }>;
}

/** One project per language: a storyboard's EN or ES text becomes the scenes. */
export async function createFromStoryboard(
  campaignId: string,
  storyboard: StoryboardLike,
  options: { language?: 'EN' | 'ES'; platform?: (typeof PLATFORMS)[number]; title?: string },
  actor: Actor,
  deps: VideoDeps = defaultVideoDeps
) {
  const lang = options.language ?? 'EN';
  const key = lang === 'ES' ? 'es' : 'en';
  const project = await createVideoProject(
    {
      campaignId,
      title: options.title ?? `${storyboard.title} (${lang})`,
      platform: options.platform ?? 'TIKTOK',
      language: lang,
      targetDurationSec: Math.ceil(storyboard.totalDurationSec),
    },
    actor,
    deps
  );
  const scenes = [...storyboard.scenes].sort((a, b) => a.order - b.order);
  await deps.db.$transaction(async (tx) => {
    for (const [i, s] of scenes.entries()) {
      const data = parse(sceneCreateSchema, {
        durationSec: Math.round(s.durationSec * 100) / 100,
        visualCue: s.visual,
        onScreenText: s.onScreenText[key],
        voiceover: s.voiceover?.[key] ?? null,
        textPosition: 'CENTER',
      });
      await tx.videoScene.create({ data: { ...data, textBox: data.textBox ?? Prisma.JsonNull, videoProjectId: project.id, order: i + 1 } });
    }
  });
  return getVideoProject(project.id, actor, deps);
}

async function loadForValidation(project: VideoProject, deps: VideoDeps) {
  const scenes = await deps.db.videoScene.findMany({ where: { videoProjectId: project.id }, orderBy: { order: 'asc' } });
  const assetIds = [...new Set(scenes.map((s) => s.assetId).filter((id): id is string => Boolean(id)))];
  const assets = assetIds.length ? await deps.db.marketingAsset.findMany({ where: { id: { in: assetIds } } }) : [];
  const campaign = project.campaignId
    ? await deps.db.marketingCampaign.findUnique({
        where: { id: project.campaignId },
        select: { id: true, brandProfileId: true, discountPct: true, productIds: true },
      })
    : null;
  const brand = await deps.getBrand(campaign?.brandProfileId ?? null);
  const discount = campaign?.discountPct == null ? null : toNumber(campaign.discountPct);
  const validation = validateVideoProject({
    project: { platform: project.platform, aspectRatio: project.aspectRatio, targetDurationSec: project.targetDurationSec, language: project.language },
    scenes: scenes.map((s) => ({ ...s, durationSec: num(s.durationSec) })),
    assets: new Map(assets.map((a) => [a.id, { ...a, durationSec: num(a.durationSec) }])),
    brand,
    approvedDiscountPct: discount,
  });
  return { scenes, assets, campaign, brand, discount, validation };
}

export async function getVideoProject(id: string, actor: Actor, deps: VideoDeps = defaultVideoDeps) {
  requireAction(actor, 'view');
  const project = await deps.db.videoProject.findUnique({ where: { id } });
  if (!project) throw marketingErrors.notFound('Video project', id);
  const { scenes, validation } = await loadForValidation(project, deps);
  return { project, phase: videoPhase(project), scenes, validation };
}

const listSchema = z
  .object({
    campaignId: z.string().optional(),
    platform: z.enum(PLATFORMS).optional(),
    page: z.number().int().min(1).default(1),
    pageSize: z.number().int().min(1).max(100).default(DEFAULT_PAGE_SIZE),
  })
  .strict();

export async function listVideoProjects(query: z.input<typeof listSchema>, actor: Actor, deps: VideoDeps = defaultVideoDeps) {
  requireAction(actor, 'view');
  const q = parse(listSchema, query);
  const where: Prisma.VideoProjectWhereInput = { ...(q.campaignId ? { campaignId: q.campaignId } : {}), ...(q.platform ? { platform: q.platform } : {}) };
  const [items, total] = await Promise.all([
    deps.db.videoProject.findMany({ where, orderBy: { updatedAt: 'desc' }, ...pageWindow(q.page, q.pageSize) }),
    deps.db.videoProject.count({ where }),
  ]);
  return { items: items.map((p) => ({ ...p, phase: videoPhase(p) })), total, page: q.page, pageSize: q.pageSize, totalPages: totalPages(total, q.pageSize) };
}

// =============================================================================
// Edits (all go through mutate(): version bump + back to DRAFT)
// =============================================================================

async function logDecision(
  tx: Prisma.TransactionClient,
  project: VideoProject,
  from: VideoProject['status'],
  to: VideoProject['status'],
  actor: Actor,
  extra: { comment?: string | null; evaluation?: unknown; verdict?: 'PASS' | 'WARN' | 'BLOCK' | null; acknowledged?: boolean } = {}
) {
  // CampaignApproval requires a campaign; every project created through this
  // service has one.
  if (!project.campaignId) return;
  await tx.campaignApproval.create({
    data: {
      campaignId: project.campaignId,
      targetType: 'VIDEO_PROJECT',
      targetId: project.id,
      fromStatus: from,
      toStatus: to,
      decidedById: actor.userId,
      comment: extra.comment ?? null,
      safeguardVerdict: extra.verdict ?? null,
      safeguardSnapshot: extra.evaluation ? json(extra.evaluation) : Prisma.JsonNull,
      warningsAcknowledged: Boolean(extra.acknowledged),
    },
  });
}

async function mutate<T>(
  projectId: string,
  actor: Actor,
  reason: string,
  deps: VideoDeps,
  fn: (tx: Prisma.TransactionClient, project: VideoProject) => Promise<T>
): Promise<T> {
  requireAction(actor, 'draft');
  return deps.db.$transaction(async (tx) => {
    const project = await tx.videoProject.findUnique({ where: { id: projectId } });
    if (!project) throw marketingErrors.notFound('Video project', projectId);
    const phase = videoPhase(project);
    if (LOCKED.has(phase)) throw marketingErrors.invalidState(`A ${phase} video project cannot be edited`);

    const result = await fn(tx, project);

    const { count } = await tx.videoProject.updateMany({
      where: { id: projectId, version: project.version },
      data: {
        version: { increment: 1 },
        status: 'DRAFT',
        approvedVersion: null,
        approvedById: null,
        approvedAt: null,
        ...(project.renderStatus === 'FAILED' ? { renderStatus: 'NOT_STARTED', errorMessage: null } : {}),
      },
    });
    if (count !== 1) throw marketingErrors.invalidState(`Video project ${projectId} changed concurrently; reload and retry`);
    if (project.status !== 'DRAFT') await logDecision(tx, project, project.status, 'DRAFT', actor, { comment: `${reason} — approval cleared` });
    return result;
  });
}

/** Two-pass renumber so the (videoProjectId, order) unique index is never
 * violated mid-update: first park changed rows on negative orders, then
 * write the final orders. */
async function applyOrders(tx: Prisma.TransactionClient, current: SequencedScene[], next: SequencedScene[]) {
  const changed = changedAssignments(current, next);
  for (const [i, a] of changed.entries()) await tx.videoScene.update({ where: { id: a.id }, data: { order: -(i + 1) } });
  for (const a of changed) await tx.videoScene.update({ where: { id: a.id }, data: { order: a.order } });
}

function seqError<T>(fn: () => T): T {
  try {
    return fn();
  } catch (err) {
    if (err instanceof SequenceError) throw marketingErrors.invalidInput(err.message);
    throw err;
  }
}

export async function updateVideoProject(id: string, patch: unknown, actor: Actor, deps: VideoDeps = defaultVideoDeps) {
  const p = parse(projectPatchSchema, patch);
  return mutate(id, actor, 'Project edited', deps, async (tx, project) => {
    const platform = p.platform ?? project.platform;
    await checkTargetDuration(platform, p.targetDurationSec !== undefined ? p.targetDurationSec : project.targetDurationSec);
    if (p.templateId !== undefined || p.platform) await checkTemplate(tx, p.templateId !== undefined ? p.templateId : project.templateId, platform);
    if (p.audioAssetId !== undefined) await checkAsset(tx, p.audioAssetId, ['AUDIO']);
    return tx.videoProject.update({
      where: { id },
      data: { ...p, ...(p.platform ? { aspectRatio: VIDEO_PLATFORM_RULES[p.platform].aspectRatios[0] } : {}) },
    });
  });
}

export async function addScene(projectId: string, input: unknown, actor: Actor, options: { position?: number } = {}, deps: VideoDeps = defaultVideoDeps) {
  const s = parse(sceneCreateSchema, input);
  return mutate(projectId, actor, 'Scene added', deps, async (tx) => {
    await checkAsset(tx, s.assetId, ['IMAGE', 'VIDEO']);
    const current = await tx.videoScene.findMany({ where: { videoProjectId: projectId }, select: { id: true, order: true } });
    if (current.length >= SCENE_LIMITS.maxScenes) throw marketingErrors.invalidInput(`A video can have at most ${SCENE_LIMITS.maxScenes} scenes`);
    const plan = seqError(() => planInsert(current, options.position));
    await applyOrders(tx, current, plan.assignments);
    return tx.videoScene.create({ data: { ...s, textBox: s.textBox ?? Prisma.JsonNull, videoProjectId: projectId, order: plan.position } });
  });
}

async function sceneOrThrow(sceneId: string, deps: VideoDeps): Promise<VideoScene> {
  const scene = await deps.db.videoScene.findUnique({ where: { id: sceneId } });
  if (!scene) throw marketingErrors.notFound('Scene', sceneId);
  return scene;
}

/** Also the way to (re)assign or clear a scene's asset. */
export async function updateScene(sceneId: string, patch: unknown, actor: Actor, deps: VideoDeps = defaultVideoDeps) {
  const p = parse(scenePatchSchema, patch);
  const scene = await sceneOrThrow(sceneId, deps);
  return mutate(scene.videoProjectId, actor, `Scene ${scene.order} edited`, deps, async (tx) => {
    if (p.assetId !== undefined) await checkAsset(tx, p.assetId, ['IMAGE', 'VIDEO']);
    const { textBox, ...rest } = p;
    const data: Prisma.VideoSceneUpdateInput = { ...rest, ...(textBox !== undefined ? { textBox: textBox ?? Prisma.JsonNull } : {}) };
    return tx.videoScene.update({ where: { id: sceneId }, data });
  });
}

export async function removeScene(sceneId: string, actor: Actor, deps: VideoDeps = defaultVideoDeps) {
  const scene = await sceneOrThrow(sceneId, deps);
  return mutate(scene.videoProjectId, actor, `Scene ${scene.order} removed`, deps, async (tx) => {
    const current = await tx.videoScene.findMany({ where: { videoProjectId: scene.videoProjectId }, select: { id: true, order: true } });
    const next = seqError(() => planRemove(current, sceneId));
    await tx.videoScene.delete({ where: { id: sceneId } });
    await applyOrders(tx, current.filter((c) => c.id !== sceneId), next);
  });
}

export async function reorderScenes(projectId: string, orderedSceneIds: string[], actor: Actor, deps: VideoDeps = defaultVideoDeps) {
  return mutate(projectId, actor, 'Scenes reordered', deps, async (tx) => {
    const current = await tx.videoScene.findMany({ where: { videoProjectId: projectId }, select: { id: true, order: true } });
    const next = seqError(() => planReorder(current, orderedSceneIds));
    await applyOrders(tx, current, next);
  });
}

export async function moveScene(sceneId: string, toPosition: number, actor: Actor, deps: VideoDeps = defaultVideoDeps) {
  const scene = await sceneOrThrow(sceneId, deps);
  return mutate(scene.videoProjectId, actor, `Scene ${scene.order} moved`, deps, async (tx) => {
    const current = await tx.videoScene.findMany({ where: { videoProjectId: scene.videoProjectId }, select: { id: true, order: true } });
    await applyOrders(tx, current, seqError(() => planMove(current, sceneId, toPosition)));
  });
}

// =============================================================================
// Review / approval
// =============================================================================

const TRANSITIONS: Partial<Record<VideoPhase, Partial<Record<VideoPhase, MarketingAction>>>> = {
  DRAFT: { REVIEW: 'submit_for_review' },
  REVIEW: { APPROVED: 'approve', REJECTED: 'reject', DRAFT: 'draft' },
  APPROVED: { DRAFT: 'draft' },
  REJECTED: { DRAFT: 'draft' },
  FAILED: { DRAFT: 'draft' },
};

function invalid(validation: VideoValidation, stage: string): never {
  const blocks = validation.issues.filter((i) => i.severity === 'BLOCK');
  throw marketingErrors.unprocessable('VIDEO_INVALID', `Video cannot be ${stage}: ${blocks.map((b) => b.message).join('; ')}`, blocks);
}

async function campaignSafeguards(campaign: { productIds: string[] } | null, discount: number | null, deps: VideoDeps, stage: string) {
  if (!campaign) return null;
  const evaluation = await evaluateCampaignSafeguards(campaign.productIds, discount, deps.safeguards, { now: deps.now });
  if (evaluation.verdict === 'BLOCK') throw new CampaignSafeguardError(evaluation, stage);
  return evaluation;
}

export async function transitionVideoProject(
  id: string,
  to: 'REVIEW' | 'APPROVED' | 'REJECTED' | 'DRAFT',
  actor: Actor,
  options: { comment?: string; acknowledgeWarnings?: boolean } = {},
  deps: VideoDeps = defaultVideoDeps
) {
  const project = await deps.db.videoProject.findUnique({ where: { id } });
  if (!project) throw marketingErrors.notFound('Video project', id);
  const from = videoPhase(project);
  const action = TRANSITIONS[from]?.[to];
  if (!action) throw marketingErrors.invalidState(`Cannot move a video project from ${from} to ${to}`);
  requireAction(actor, action);

  const comment = options.comment?.trim() || null;
  if (to === 'REJECTED' && !comment) throw marketingErrors.invalidInput('A rejection requires a comment');

  let evaluation: SafeguardEvaluation | null = null;
  let warned = false;
  if (to === 'REVIEW' || to === 'APPROVED') {
    const ctx = await loadForValidation(project, deps);
    if (ctx.validation.verdict === 'BLOCK') invalid(ctx.validation, to === 'REVIEW' ? 'submitted' : 'approved');
    warned = ctx.validation.verdict === 'WARN';
    if (to === 'APPROVED') {
      evaluation = await campaignSafeguards(ctx.campaign, ctx.discount, deps, 'video approval');
      warned ||= evaluation?.verdict === 'WARN';
      if (warned && !options.acknowledgeWarnings) {
        throw new MarketingError('WARNINGS_NOT_ACKNOWLEDGED', 'Warnings must be acknowledged before approval.', 422, {
          video: ctx.validation.issues.filter((i) => i.severity === 'WARN'),
          safeguards: evaluation,
        });
      }
    }
  }

  const status = to === 'REVIEW' ? 'HUMAN_REVIEW' : to;
  const now = deps.now();
  return deps.db.$transaction(async (tx) => {
    const { count } = await tx.videoProject.updateMany({
      where: { id, version: project.version, status: project.status, renderStatus: project.renderStatus },
      data: {
        status,
        ...(to === 'APPROVED'
          ? { approvedVersion: project.version, approvedById: actor.userId, approvedAt: now }
          : { approvedVersion: null, approvedById: null, approvedAt: null }),
        ...(to === 'DRAFT' && project.renderStatus === 'FAILED' ? { renderStatus: 'NOT_STARTED' as const, errorMessage: null } : {}),
      },
    });
    if (count !== 1) throw marketingErrors.invalidState(`Video project ${id} changed concurrently; reload and retry`);
    await logDecision(tx, project, project.status, status, actor, {
      comment,
      evaluation,
      verdict: evaluation?.verdict ?? null,
      acknowledged: Boolean(options.acknowledgeWarnings && warned),
    });
    return tx.videoProject.findUnique({ where: { id } });
  });
}

// =============================================================================
// Rendering
// =============================================================================

/** Deterministic render job identity: one key per (project, version, attempt),
 * so a replayed start can never create a second job and n8n can dedupe on it. */
export function videoRenderKey(projectId: string, version: number, attempt: number): string {
  return `video-render:${projectId}:v${version}:a${attempt}`;
}

export function videoRenderJobId(key: string): string {
  return `vr_${crypto.createHash('sha256').update(key).digest('hex').slice(0, 32)}`;
}

/** Values the system computes; callers can't override prices or discount. */
const SYSTEM_TEMPLATE_KEYS = new Set(['price', 'promo_price', 'discount_pct', 'discount_badge', 'brand_name', 'product_sku']);

export async function startRender(
  id: string,
  actor: Actor,
  options: { callbackUrl?: string; templateValues?: Record<string, PlaceholderValue> } = {},
  deps: VideoDeps = defaultVideoDeps
): Promise<{ payload: RenderPayload; scheduleId: string }> {
  requireAction(actor, 'schedule');
  const project = await deps.db.videoProject.findUnique({ where: { id } });
  if (!project) throw marketingErrors.notFound('Video project', id);
  const phase = videoPhase(project);
  if (phase !== 'APPROVED' && phase !== 'FAILED') throw marketingErrors.invalidState(`Only APPROVED (or FAILED, to retry) projects can render; this one is ${phase}`);
  if (project.status !== 'APPROVED' || !project.approvedById || project.approvedVersion !== project.version) {
    throw marketingErrors.invalidState('This version has not been approved by an ADMIN');
  }
  if (options.callbackUrl && !/^https:\/\//.test(options.callbackUrl)) throw marketingErrors.invalidInput('callbackUrl must be https');

  const ctx = await loadForValidation(project, deps);
  if (ctx.validation.verdict === 'BLOCK') invalid(ctx.validation, 'rendered');
  const evaluation = await campaignSafeguards(ctx.campaign, ctx.discount, deps, 'render');

  // Template
  let template = null;
  const values: Record<string, PlaceholderValue> = {};
  for (const [k, v] of Object.entries(options.templateValues ?? {})) if (!SYSTEM_TEMPLATE_KEYS.has(k)) values[k] = v;
  if (project.templateId) {
    const t = await deps.db.marketingTemplate.findUnique({ where: { id: project.templateId } });
    if (!t || !t.active) throw marketingErrors.invalidState('The project template is missing or inactive');
    template = {
      id: t.id,
      provider: t.provider,
      externalTemplateId: t.externalTemplateId,
      placeholders: t.placeholders,
      declarations: (t.variables as PlaceholderDeclaration[] | null) ?? [],
    };
    const productId = ctx.campaign?.productIds[0];
    const product = productId ? await deps.loadProduct(productId) : null;
    const margin = evaluation?.products.find((p) => p.productId === productId)?.margin;
    if (product) {
      values.product_name ??= product.name;
      values.product_sku = product.sku;
      values.price = product.price;
    }
    if (ctx.discount && ctx.discount > 0) {
      values.discount_pct = ctx.discount;
      values.discount_badge = project.language === 'ES' ? `${ctx.discount}% DESC.` : `${ctx.discount}% OFF`;
      if (margin?.promoPrice != null) values.promo_price = margin.promoPrice;
    }
    if (ctx.brand) values.brand_name = ctx.brand.name;
  }

  const [audio] = project.audioAssetId ? await deps.db.marketingAsset.findMany({ where: { id: { in: [project.audioAssetId] } } }) : [];
  const toPayloadAsset = (a: (typeof ctx.assets)[number]): PayloadAsset => ({
    id: a.id,
    type: a.type,
    url: a.url,
    mimeType: a.mimeType,
    width: a.width,
    height: a.height,
    durationSec: num(a.durationSec),
  });

  const idempotencyKey = videoRenderKey(project.id, project.version, project.renderAttempts + 1);
  const jobId = videoRenderJobId(idempotencyKey);
  let payload: RenderPayload;
  try {
    payload = assembleRenderPayload({
      jobId,
      project,
      scenes: ctx.scenes.map((s) => ({ ...s, durationSec: num(s.durationSec) ?? 0 })),
      assets: new Map(ctx.assets.map((a) => [a.id, toPayloadAsset(a)])),
      audioAsset: audio ? toPayloadAsset(audio) : null,
      template,
      templateValues: values,
      callbackUrl: options.callbackUrl ?? null,
      resolveAssetUrl: deps.resolveAssetUrl,
      now: deps.now(),
    });
  } catch (err) {
    if (err instanceof PayloadAssemblyError) throw marketingErrors.unprocessable('PAYLOAD_INVALID', err.message, err.problems);
    throw err;
  }

  const now = deps.now();
  await deps.db.$transaction(async (tx) => {
    const { count } = await tx.videoProject.updateMany({
      where: { id, version: project.version, status: 'APPROVED', renderStatus: project.renderStatus },
      data: {
        renderStatus: 'QUEUED',
        externalJobId: jobId,
        renderRequestedAt: now,
        renderAttempts: { increment: 1 },
        errorMessage: null,
        outputAssetId: null,
      },
    });
    if (count !== 1) throw marketingErrors.invalidState(`Video project ${id} changed concurrently; reload and retry`);
    await tx.marketingSchedule.create({
      data: {
        id: jobId,
        idempotencyKey,
        checksum: payload.checksum,
        jobType: 'VIDEO_RENDER',
        status: 'PENDING',
        runAt: now,
        campaignId: project.campaignId,
        n8nWorkflow: 'video-render',
        payload: json(payload),
      },
    });
    await logDecision(tx, project, 'APPROVED', 'SCHEDULED', actor, {
      comment: `Render queued (job ${jobId}, attempt ${project.renderAttempts + 1})`,
      evaluation,
      verdict: evaluation?.verdict ?? null,
    });
  });
  return { payload, scheduleId: jobId };
}

const renderEventSchema = z
  .object({
    jobId: z.string().min(1),
    status: z.enum(['RENDERING', 'COMPLETED', 'FAILED']),
    outputAssetId: z.string().min(1).optional(),
    error: z.string().max(5000).optional(),
  })
  .strict();

const RENDER_NEXT: Record<string, string[]> = { QUEUED: ['RENDERING', 'COMPLETED', 'FAILED'], RENDERING: ['COMPLETED', 'FAILED'] };

/**
 * System entry point for render progress (called by the authenticated n8n
 * callback handler, not by users). Idempotent and stale-safe: events for an
 * older job, repeats, and events after a terminal state are ignored.
 */
export async function recordRenderEvent(projectId: string, event: unknown, deps: VideoDeps = defaultVideoDeps) {
  const e = parse(renderEventSchema, event);
  const project = await deps.db.videoProject.findUnique({ where: { id: projectId } });
  if (!project) throw marketingErrors.notFound('Video project', projectId);
  if (project.externalJobId !== e.jobId) return { applied: false as const, reason: 'STALE_JOB', phase: videoPhase(project) };
  if (project.renderStatus === e.status) return { applied: false as const, reason: 'DUPLICATE', phase: videoPhase(project) };
  if (!RENDER_NEXT[project.renderStatus]?.includes(e.status)) {
    return { applied: false as const, reason: 'TERMINAL_OR_OUT_OF_ORDER', phase: videoPhase(project) };
  }

  if (e.status === 'COMPLETED') {
    if (!e.outputAssetId) throw marketingErrors.invalidInput('COMPLETED requires outputAssetId');
    const asset = await deps.db.marketingAsset.findUnique({ where: { id: e.outputAssetId } });
    if (!asset || asset.type !== 'VIDEO' || asset.archivedAt) throw marketingErrors.invalidInput(`Output ${e.outputAssetId} is not an active VIDEO asset`);
  }

  const now = deps.now();
  await deps.db.$transaction(async (tx) => {
    const { count } = await tx.videoProject.updateMany({
      where: { id: projectId, externalJobId: e.jobId, renderStatus: project.renderStatus },
      data: {
        renderStatus: e.status,
        ...(e.status === 'COMPLETED' ? { outputAssetId: e.outputAssetId, renderedAt: now, errorMessage: null } : {}),
        ...(e.status === 'FAILED' ? { errorMessage: redactText(e.error ?? 'Render failed').slice(0, 500) } : {}),
      },
    });
    if (count !== 1) throw marketingErrors.invalidState('Render state changed concurrently');
    if (e.status !== 'RENDERING') {
      await tx.marketingSchedule.updateMany({
        where: { id: e.jobId },
        data: { status: e.status === 'COMPLETED' ? 'COMPLETED' : 'FAILED', completedAt: now, lastError: e.status === 'FAILED' ? redactText(e.error ?? '').slice(0, 500) : null },
      });
    }
  });
  return { applied: true as const, phase: videoPhase({ status: project.status, renderStatus: e.status }) };
}

/** Route guard: a scene id in a URL must belong to the project in that URL. */
export async function assertSceneInProject(sceneId: string, projectId: string, deps: VideoDeps = defaultVideoDeps): Promise<void> {
  const scene = await deps.db.videoScene.findUnique({ where: { id: sceneId }, select: { videoProjectId: true } });
  if (!scene || scene.videoProjectId !== projectId) throw marketingErrors.notFound('Scene', sceneId);
}
