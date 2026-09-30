import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  idempotencyKeyFor,
  jobIdFor,
  platformOptions,
  validatePost,
  buildDispatchPackage,
  signedDispatchRequest,
  IDEMPOTENCY_HEADER,
  type PostMedia,
  type PackageInput,
} from '@/marketing/publishing/packages';
import {
  createSocialPost,
  updateSocialPost,
  transitionSocialPost,
  schedulePost,
  reschedulePost,
  unschedulePost,
  retryFailedPost,
  recordPublishResult,
  socialPostPhase,
  getSocialPost,
  listSocialPosts,
} from '@/marketing/publishing/post-service';
import { dispatchDueSocialPosts, dispatchJob, DISPATCH_LEASE_MS } from '@/marketing/publishing/dispatch';
import type { PublishingDeps } from '@/marketing/publishing/deps';
import { verifyWebhook, SIGNATURE_HEADER, TIMESTAMP_HEADER, JOB_ID_HEADER } from '@/marketing/security/signing';
import { MarketingError } from '@/marketing/errors';
import { CampaignError } from '@/marketing/campaigns/errors';
import type { InventoryStatus, MarginViability } from '@/marketing/ai/safeguards';
import type { SocialPost } from '@prisma/client';
import { fakeModel, makeBrand } from './marketing-fixtures';

/**
 * Marketing Phase 10: social publishing lifecycle, ADMIN publishing gate,
 * idempotent scheduling, pre-dispatch safeguard re-validation, signed n8n
 * dispatch with retries, and exactly-once publish results.
 */

const brand = makeBrand();
const sales = { userId: 'u_sales', role: 'SALES' };
const admin = { userId: 'u_admin', role: 'ADMIN' };
const SECRET = 's'.repeat(40);
const WEBHOOK = 'https://n8n.example.com/webhook/marketing/social-publish';

async function expectError(p: Promise<unknown>, code: string, status: number) {
  const err = await p.then(
    () => {
      throw new Error(`expected ${code}, but the call succeeded`);
    },
    (e: MarketingError | CampaignError) => e
  );
  expect(err instanceof MarketingError || err instanceof CampaignError, String(err)).toBe(true);
  expect(err).toMatchObject({ code, httpStatus: status });
  return err;
}

const image = (over: Partial<PostMedia> = {}): PostMedia => ({
  id: 'img',
  type: 'IMAGE',
  url: 'https://cdn.example.com/oven.png',
  mimeType: 'image/png',
  width: 1080,
  height: 1350,
  sizeBytes: 500_000,
  durationSec: null,
  altText: 'Oven',
  archivedAt: null,
  ...over,
});
const video = (over: Partial<PostMedia> = {}): PostMedia =>
  image({ id: 'vid', type: 'VIDEO', url: 'https://cdn.example.com/reel.mp4', mimeType: 'video/mp4', width: 1080, height: 1920, sizeBytes: 20_000_000, durationSec: 30, ...over });

// =============================================================================
describe('idempotency keys and packages (pure)', () => {
  it('derives a stable job id per post version and retry generation', () => {
    const k = idempotencyKeyFor('post1', 3, 0);
    expect(k).toBe('social-post:post1:v3:g0');
    expect(jobIdFor(k)).toBe(jobIdFor('social-post:post1:v3:g0'));
    expect(jobIdFor(k)).toMatch(/^sp_[a-f0-9]{32}$/);
    const others = [idempotencyKeyFor('post1', 4, 0), idempotencyKeyFor('post1', 3, 1), idempotencyKeyFor('post2', 3, 0)].map(jobIdFor);
    expect(new Set([jobIdFor(k), ...others]).size).toBe(4);
  });

  it('chooses platform-specific options', () => {
    expect(platformOptions('INSTAGRAM', [{ type: 'IMAGE' }])).toMatchObject({ mediaType: 'IMAGE' });
    expect(platformOptions('INSTAGRAM', [{ type: 'VIDEO' }])).toMatchObject({ mediaType: 'REELS' });
    expect(platformOptions('INSTAGRAM', [{ type: 'IMAGE' }, { type: 'IMAGE' }])).toMatchObject({ mediaType: 'CAROUSEL' });
    expect(platformOptions('FACEBOOK', [])).toEqual({ postType: 'TEXT' });
    expect(platformOptions('FACEBOOK', [{ type: 'IMAGE' }, { type: 'IMAGE' }])).toEqual({ postType: 'ALBUM' });
    expect(platformOptions('TIKTOK', [{ type: 'VIDEO' }])).toMatchObject({ postMode: 'DIRECT_POST', commercialContent: { yourBrand: true } });
  });

  it('validates posts per platform', () => {
    const v = (p: Partial<Parameters<typeof validatePost>[0]>) =>
      validatePost({ platform: 'INSTAGRAM', caption: 'Hi. Prices subject to change.', media: [image()], brand, language: 'EN', approvedDiscountPct: null, ...p }).issues.map((i) => `${i.severity}:${i.code}`);
    expect(v({})).toEqual([]);
    expect(v({ media: [] })).toEqual(['BLOCK:MEDIA_REQUIRED']);
    expect(v({ platform: 'TIKTOK', media: [image({ width: 1080, height: 1920 })] })).toEqual(['BLOCK:VIDEO_REQUIRED']);
    expect(v({ platform: 'TIKTOK', media: [video()] })).toEqual([]);
    expect(v({ platform: 'FACEBOOK', media: [] })).toEqual([]);
    expect(v({ caption: 'x'.repeat(2201) })).toContain('BLOCK:CAPTION_TOO_LONG');
    expect(v({ caption: Array.from({ length: 31 }, (_, i) => `#t${i}`).join(' ') })).toContain('BLOCK:TOO_MANY_HASHTAGS');
    expect(v({ caption: 'Guaranteed best oven. Prices subject to change.' })).toContain('BLOCK:COPY_COMPLIANCE');
    expect(v({ media: [image({ width: 1080, height: 1920 })] })).toContain('BLOCK:MEDIA_NOT_FIT');
    expect(v({ media: [image({ url: '/api/documents/d1/download' })], resolveAssetUrl: (m) => (m.url.startsWith('https://') ? m.url : null) })).toEqual([
      'BLOCK:MEDIA_URL_UNRESOLVED',
    ]);
    expect(v({ media: [], missingMediaIds: ['gone'] })).toEqual(['BLOCK:MEDIA_NOT_FOUND', 'BLOCK:MEDIA_REQUIRED']);
  });

  const pkgInput = (): PackageInput => ({
    jobId: 'sp_x',
    idempotencyKey: 'social-post:p:v1:g0',
    platform: 'INSTAGRAM',
    account: { id: 'acc', externalAccountId: '1784', handle: '@ctbrick', n8nCredentialRef: 'ig-main' },
    post: {
      id: 'p',
      campaignId: 'c',
      version: 1,
      language: 'EN',
      caption: 'Hi',
      scheduledFor: new Date('2026-10-01T15:00:00Z'),
      approvedById: 'u_admin',
      approvedAt: new Date('2026-09-28T10:00:00Z'),
      approvedVersion: 1,
    },
    media: [image()],
    resolveAssetUrl: (m) => m.url,
    callbackUrl: 'https://crm.example.com/api/marketing/webhooks/n8n',
    createdAt: new Date('2026-09-28T12:00:00Z'),
  });

  it('builds a deterministic package and a verifiable signed request', () => {
    const a = buildDispatchPackage(pkgInput());
    expect(a).toMatchObject({ schema: 'marketing.social.publish/v1', platform: 'INSTAGRAM', platformOptions: { mediaType: 'IMAGE' }, media: [{ position: 1, url: 'https://cdn.example.com/oven.png' }] });
    expect(buildDispatchPackage(pkgInput()).checksum).toBe(a.checksum);

    const now = Date.parse('2026-10-01T15:00:00Z');
    const r1 = signedDispatchRequest(a, SECRET, now);
    const r2 = signedDispatchRequest(a, SECRET, now + 60_000);
    expect(r1.body).toBe(r2.body); // retries are byte-identical
    expect(r1.headers[JOB_ID_HEADER]).toBe('sp_x');
    expect(r1.headers[IDEMPOTENCY_HEADER]).toBe('social-post:p:v1:g0');
    expect(verifyWebhook({ rawBody: r1.body, secret: SECRET, timestamp: r1.headers[TIMESTAMP_HEADER], signature: r1.headers[SIGNATURE_HEADER], nowMs: now })).toEqual({ ok: true });
    expect(verifyWebhook({ rawBody: r1.body.replace('Hi', 'Hey'), secret: SECRET, timestamp: r1.headers[TIMESTAMP_HEADER], signature: r1.headers[SIGNATURE_HEADER], nowMs: now }).ok).toBe(false);
  });
});

// =============================================================================
function setup() {
  const socialPost = fakeModel('post', {
    status: 'DRAFT',
    version: 1,
    approvedVersion: null,
    approvedById: null,
    approvedAt: null,
    dispatchJobId: null,
    dispatchGeneration: 0,
    dispatchedAt: null,
    scheduledFor: null,
    externalPostId: null,
    permalink: null,
    errorMessage: null,
    safeguardSnapshot: null,
    compliance: null,
    contentId: null,
    videoProjectId: null,
    language: 'EN',
  });
  const marketingSchedule = fakeModel('job', { status: 'PENDING', attempt: 0, maxAttempts: 3, payload: null, checksum: null, dispatchedAt: null, lastError: null, idempotencyKey: null, completedAt: null });
  const socialAccount = fakeModel('acc', { status: 'ACTIVE', handle: '@ctbrick', n8nCredentialRef: 'ig-main' });
  const marketingCampaign = fakeModel('cmp', { startsAt: null, endsAt: null });
  const marketingContent = fakeModel('cnt');
  const marketingAsset = fakeModel('asset', { archivedAt: null });
  const videoProject = fakeModel('vp');
  const campaignApproval = fakeModel('apr');
  const db: Record<string, unknown> = { socialPost, marketingSchedule, socialAccount, marketingCampaign, marketingContent, marketingAsset, videoProject, campaignApproval };
  db.$transaction = async (fn: (tx: unknown) => unknown) => fn(db);

  let clock = new Date('2026-09-28T12:00:00Z');
  const state = { stock: 'PASS' as 'PASS' | 'WARN' | 'BLOCK', listPrice: 2499, admins: new Set(['u_admin']) };
  const checkInventory = vi.fn(async (id: string): Promise<InventoryStatus> => ({
    productId: id,
    verdict: state.stock,
    issues: state.stock === 'PASS' ? [] : [{ code: 'INSUFFICIENT_STOCK', severity: state.stock, message: `stock ${state.stock}` }],
    trackInventory: true,
    onHand: 10,
    draftCommitted: 0,
    available: 10,
    requiredMinimum: 3,
    reorderPoint: 0,
  }));
  const checkMargin = vi.fn(async (id: string, pct: number): Promise<MarginViability> => ({
    productId: id,
    verdict: 'PASS',
    issues: [],
    listPrice: state.listPrice,
    discountPct: pct,
    promoPrice: Math.round(state.listPrice * (1 - pct / 100) * 100) / 100,
    unitCost: 1000,
    costSource: 'purchase_history',
    marginPct: 50,
    minMarginPct: 25,
    maxDiscountPct: 40,
  }));
  const responses: Array<number | Error> = [];
  const send = vi.fn(async (_req: { url: string; headers: Record<string, string>; body: string }) => {
    const r = responses.shift() ?? 202;
    if (r instanceof Error) throw r;
    return { status: r };
  });
  const deps: PublishingDeps = {
    db: db as never,
    safeguards: { checkInventory, checkMargin },
    getBrand: async () => brand,
    isActiveAdmin: vi.fn(async (id: string) => state.admins.has(id)),
    resolveAssetUrl: (a) => (a.url.startsWith('https://') ? a.url : null),
    send,
    webhookUrl: () => WEBHOOK,
    callbackUrl: () => 'https://crm.example.com/api/marketing/webhooks/n8n',
    signingSecret: () => SECRET,
    now: () => clock,
  };
  const advance = (ms: number) => (clock = new Date(clock.getTime() + ms));
  return { db, deps, state, send, responses, advance, socialPost, marketingSchedule, socialAccount, marketingCampaign, marketingContent, marketingAsset, videoProject, campaignApproval };
}

async function seeded() {
  const s = setup();
  const account = await s.socialAccount.create({ data: { platform: 'INSTAGRAM', externalAccountId: '1784' } });
  const campaign = await s.marketingCampaign.create({ data: { status: 'APPROVED', productIds: ['p1'], discountPct: 15, brandProfileId: 'bp1' } });
  const asset = await s.marketingAsset.create({
    data: { type: 'IMAGE', url: 'https://cdn.example.com/oven.png', mimeType: 'image/png', width: 1080, height: 1350, sizeBytes: 500_000, durationSec: null, altText: 'Oven' },
  });
  const content = await s.marketingContent.create({
    data: {
      campaignId: campaign.id,
      status: 'APPROVED',
      channel: 'INSTAGRAM',
      type: 'CAPTION',
      language: 'en',
      title: 'Fall pizza season',
      body: 'Our brick oven, now 15% off. Prices subject to change.\n\nShop now',
      hashtags: ['#BrickOven'],
    },
  });
  const post = await createSocialPost({ socialAccountId: account.id, campaignId: campaign.id, contentId: content.id, mediaAssetIds: [asset.id] }, sales, s.deps);
  return { ...s, account, campaign, asset, content, postId: post.id };
}

type Seeded = Awaited<ReturnType<typeof seeded>>;
const at = new Date('2026-09-29T15:00:00Z');

async function approved(s: Seeded) {
  await transitionSocialPost(s.postId, 'REVIEW', sales, {}, s.deps);
  return transitionSocialPost(s.postId, 'APPROVED', admin, {}, s.deps);
}
async function scheduled(s: Seeded) {
  await approved(s);
  return schedulePost(s.postId, { scheduledFor: at }, admin, s.deps);
}
const post = (s: Seeded) => s.socialPost.rows.get(s.postId)! as SocialPost;

// =============================================================================
describe('post lifecycle and publishing gate', () => {
  it('creates a DRAFT post from approved content with caption and language', async () => {
    const s = await seeded();
    expect(post(s)).toMatchObject({
      status: 'DRAFT',
      language: 'EN',
      caption: 'Fall pizza season\n\nOur brick oven, now 15% off. Prices subject to change.\n\nShop now\n\n#BrickOven',
      mediaAssetIds: [s.asset.id],
    });
    expect(socialPostPhase(post(s))).toBe('DRAFT');
  });

  it('rejects mismatched links', async () => {
    const s = await seeded();
    const other = await s.marketingCampaign.create({ data: { status: 'APPROVED', productIds: [] } });
    await expectError(createSocialPost({ socialAccountId: s.account.id, campaignId: other.id, contentId: s.content.id }, sales, s.deps), 'INVALID_INPUT', 400);
    const concept = await s.marketingContent.create({ data: { campaignId: s.campaign.id, type: 'POST_CONCEPT', channel: 'INSTAGRAM', status: 'APPROVED' } });
    await expectError(createSocialPost({ socialAccountId: s.account.id, campaignId: s.campaign.id, contentId: concept.id }, sales, s.deps), 'INVALID_INPUT', 400);
    const tt = await s.marketingContent.create({ data: { campaignId: s.campaign.id, type: 'CAPTION', channel: 'TIKTOK', status: 'APPROVED' } });
    await expectError(createSocialPost({ socialAccountId: s.account.id, campaignId: s.campaign.id, contentId: tt.id }, sales, s.deps), 'INVALID_INPUT', 400);
    const vp = await s.videoProject.create({ data: { campaignId: s.campaign.id, platform: 'INSTAGRAM_REELS', status: 'APPROVED', renderStatus: 'RENDERING', version: 1, approvedVersion: 1 } });
    await expectError(createSocialPost({ socialAccountId: s.account.id, campaignId: s.campaign.id, videoProjectId: vp.id }, sales, s.deps), 'INVALID_INPUT', 400);
    const off = await s.socialAccount.create({ data: { platform: 'FACEBOOK', externalAccountId: '9', status: 'REVOKED' } });
    await expectError(createSocialPost({ socialAccountId: off.id, campaignId: s.campaign.id }, sales, s.deps), 'INVALID_INPUT', 400);
  });

  it('links a completed, approved video render as the post media', async () => {
    const s = await seeded();
    const out = await s.marketingAsset.create({ data: { type: 'VIDEO', url: 'https://cdn.example.com/reel.mp4', mimeType: 'video/mp4', width: 1080, height: 1920, sizeBytes: 1e7, durationSec: 30 } });
    const vp = await s.videoProject.create({
      data: { campaignId: s.campaign.id, platform: 'INSTAGRAM_REELS', status: 'APPROVED', renderStatus: 'COMPLETED', version: 2, approvedVersion: 2, outputAssetId: out.id },
    });
    const p = await createSocialPost({ socialAccountId: s.account.id, campaignId: s.campaign.id, videoProjectId: vp.id, caption: 'Reel. Prices subject to change.' }, sales, s.deps);
    expect(p.mediaAssetIds).toEqual([out.id]);
  });

  it('only ADMIN approves/schedules; linked campaign and content must be approved', async () => {
    const s = await seeded();
    await transitionSocialPost(s.postId, 'REVIEW', sales, {}, s.deps);
    await expectError(transitionSocialPost(s.postId, 'APPROVED', sales, {}, s.deps), 'FORBIDDEN', 403);

    s.marketingCampaign.rows.get(s.campaign.id)!.status = 'HUMAN_REVIEW';
    await expectError(transitionSocialPost(s.postId, 'APPROVED', admin, {}, s.deps), 'LINKED_NOT_APPROVED', 422);
    s.marketingCampaign.rows.get(s.campaign.id)!.status = 'APPROVED';
    s.marketingContent.rows.get(s.content.id)!.status = 'DRAFT';
    await expectError(transitionSocialPost(s.postId, 'APPROVED', admin, {}, s.deps), 'LINKED_NOT_APPROVED', 422);
    s.marketingContent.rows.get(s.content.id)!.status = 'APPROVED';

    const p = await transitionSocialPost(s.postId, 'APPROVED', admin, {}, s.deps);
    expect(p).toMatchObject({ status: 'APPROVED', approvedById: 'u_admin', approvedVersion: 1, safeguardSnapshot: { verdict: 'PASS' } });
    await expectError(schedulePost(s.postId, { scheduledFor: at }, sales, s.deps), 'FORBIDDEN', 403);
  });

  it('schedule refuses unapproved posts, stale sign-off and bad times', async () => {
    const s = await seeded();
    await expectError(schedulePost(s.postId, { scheduledFor: at }, admin, s.deps), 'INVALID_STATE', 409);
    await approved(s);
    await expectError(schedulePost(s.postId, { scheduledFor: new Date('2026-09-27T00:00:00Z') }, admin, s.deps), 'INVALID_INPUT', 400);
    await expectError(schedulePost(s.postId, { scheduledFor: new Date('2027-03-01T00:00:00Z') }, admin, s.deps), 'INVALID_INPUT', 400);
    s.marketingCampaign.rows.get(s.campaign.id)!.endsAt = new Date('2026-09-29T00:00:00Z');
    await expectError(schedulePost(s.postId, { scheduledFor: at }, admin, s.deps), 'INVALID_INPUT', 400);
    s.marketingCampaign.rows.get(s.campaign.id)!.endsAt = null;

    s.state.admins.delete('u_admin'); // approver demoted since sign-off
    await expectError(schedulePost(s.postId, { scheduledFor: at }, { userId: 'u_admin2', role: 'ADMIN' }, s.deps), 'SIGN_OFF_INVALID', 422);
  });

  it('editing voids approval; scheduled posts must be unscheduled first', async () => {
    const s = await seeded();
    await approved(s);
    await updateSocialPost(s.postId, { caption: 'New caption. Prices subject to change.' }, sales, s.deps);
    expect(post(s)).toMatchObject({ status: 'DRAFT', version: 2, approvedVersion: null, approvedById: null });
    await expectError(schedulePost(s.postId, { scheduledFor: at }, admin, s.deps), 'INVALID_STATE', 409);

    await approved(s);
    await schedulePost(s.postId, { scheduledFor: at }, admin, s.deps);
    await expectError(updateSocialPost(s.postId, { caption: 'x' }, sales, s.deps), 'INVALID_STATE', 409);
  });

  it('safeguard BLOCK at approval refuses; WARN needs acknowledgement', async () => {
    const s = await seeded();
    await transitionSocialPost(s.postId, 'REVIEW', sales, {}, s.deps);
    s.state.stock = 'BLOCK';
    await expectError(transitionSocialPost(s.postId, 'APPROVED', admin, {}, s.deps), 'SAFEGUARD_BLOCKED', 422);
    s.state.stock = 'WARN';
    await expectError(transitionSocialPost(s.postId, 'APPROVED', admin, {}, s.deps), 'WARNINGS_NOT_ACKNOWLEDGED', 422);
    expect((await transitionSocialPost(s.postId, 'APPROVED', admin, { acknowledgeWarnings: true }, s.deps))!.status).toBe('APPROVED');
  });
});

// =============================================================================
describe('idempotent scheduling', () => {
  it('scheduling twice returns the same job and creates it once', async () => {
    const s = await seeded();
    const first = await scheduled(s);
    expect(first.created).toBe(true);
    const jobId = jobIdFor(idempotencyKeyFor(s.postId, 1, 0));
    expect(first.job!.id).toBe(jobId);
    expect(first.job).toMatchObject({ jobType: 'SOCIAL_PUBLISH', status: 'PENDING', runAt: at, idempotencyKey: 'social-post:' + s.postId + ':v1:g0' });
    expect(socialPostPhase(post(s))).toBe('SCHEDULED');

    const again = await schedulePost(s.postId, { scheduledFor: at }, admin, s.deps);
    expect(again).toMatchObject({ created: false, job: { id: jobId } });
    expect(s.marketingSchedule.rows.size).toBe(1);
  });

  it('concurrent schedule requests converge on one job', async () => {
    const s = await seeded();
    await approved(s);
    const [a, b] = await Promise.all([
      schedulePost(s.postId, { scheduledFor: at }, admin, s.deps),
      schedulePost(s.postId, { scheduledFor: at }, admin, s.deps),
    ]);
    expect(a.job!.id).toBe(b.job!.id);
    expect([a.created, b.created].sort()).toEqual([false, true]);
    expect(s.marketingSchedule.rows.size).toBe(1);
  });

  it('reschedule keeps the job; unschedule cancels; re-schedule re-arms the same job', async () => {
    const s = await seeded();
    const { job } = await scheduled(s);
    const later = new Date('2026-09-30T15:00:00Z');
    await reschedulePost(s.postId, { scheduledFor: later }, admin, s.deps);
    expect(s.marketingSchedule.rows.get(job!.id)!.runAt).toEqual(later);

    await unschedulePost(s.postId, admin, s.deps);
    expect(s.marketingSchedule.rows.get(job!.id)!.status).toBe('CANCELLED');
    expect(post(s)).toMatchObject({ status: 'APPROVED', dispatchJobId: null });

    const re = await schedulePost(s.postId, { scheduledFor: at }, admin, s.deps);
    expect(re.job).toMatchObject({ id: job!.id, status: 'PENDING', runAt: at });
    expect(s.marketingSchedule.rows.size).toBe(1);
  });
});

// =============================================================================
describe('dispatch orchestrator', () => {
  async function due(s: Seeded) {
    const r = await scheduled(s);
    s.advance(27 * 3600_000 + 1000); // past 2026-09-29T15:00Z
    return r.job!;
  }

  it('does nothing before runAt', async () => {
    const s = await seeded();
    await scheduled(s);
    expect(await dispatchDueSocialPosts({}, s.deps)).toEqual([]);
    expect(s.send).not.toHaveBeenCalled();
  });

  it('sends one signed, idempotent package and marks the post DISPATCHED', async () => {
    const s = await seeded();
    const job = await due(s);
    expect(await dispatchDueSocialPosts({}, s.deps)).toEqual([{ jobId: job.id, outcome: 'DISPATCHED' }]);
    expect(s.send).toHaveBeenCalledTimes(1);
    const req = s.send.mock.calls[0][0];
    expect(req.url).toBe(WEBHOOK);
    expect(req.headers[JOB_ID_HEADER]).toBe(job.id);
    expect(req.headers[IDEMPOTENCY_HEADER]).toBe(`social-post:${s.postId}:v1:g0`);
    expect(verifyWebhook({ rawBody: req.body, secret: SECRET, timestamp: req.headers[TIMESTAMP_HEADER], signature: req.headers[SIGNATURE_HEADER], nowMs: s.deps.now().getTime() })).toEqual({ ok: true });
    const body = JSON.parse(req.body);
    expect(body).toMatchObject({ platform: 'INSTAGRAM', platformOptions: { mediaType: 'IMAGE' }, approval: { approvedById: 'u_admin', approvedVersion: 1 }, account: { n8nCredentialRef: 'ig-main' } });
    expect(JSON.stringify(body)).not.toMatch(/unitCost|marginPct|1000/);

    expect(s.marketingSchedule.rows.get(job.id)).toMatchObject({ status: 'DISPATCHED', attempt: 1, checksum: body.checksum });
    expect(socialPostPhase(post(s))).toBe('DISPATCHED');

    // Later passes never re-send an acknowledged job.
    s.advance(DISPATCH_LEASE_MS * 2);
    expect(await dispatchDueSocialPosts({}, s.deps)).toEqual([]);
    expect(s.send).toHaveBeenCalledTimes(1);
  });

  it('two workers racing on one job send it once', async () => {
    const s = await seeded();
    const job = await due(s);
    const snapshot = { ...s.marketingSchedule.rows.get(job.id)! };
    const [a, b] = await Promise.all([dispatchJob(snapshot as never, s.deps), dispatchJob(snapshot as never, s.deps)]);
    expect([a.outcome, b.outcome].sort()).toEqual(['DISPATCHED', 'SKIPPED_CLAIMED']);
    expect(s.send).toHaveBeenCalledTimes(1);
  });

  it('retries 5xx/network with backoff using byte-identical bodies, then fails', async () => {
    const s = await seeded();
    const job = await due(s);
    s.responses.push(503, new Error('ECONNRESET'), 500);
    expect((await dispatchDueSocialPosts({}, s.deps))[0].outcome).toBe('RETRY_SCHEDULED');
    expect(s.marketingSchedule.rows.get(job.id)).toMatchObject({ status: 'PENDING', attempt: 1 });
    expect(await dispatchDueSocialPosts({}, s.deps)).toEqual([]); // backoff not elapsed

    s.advance(60_000);
    expect((await dispatchDueSocialPosts({}, s.deps))[0].outcome).toBe('RETRY_SCHEDULED');
    s.advance(5 * 60_000);
    const last = (await dispatchDueSocialPosts({}, s.deps))[0];
    expect(last).toMatchObject({ outcome: 'FAILED' });

    const bodies = s.send.mock.calls.map((c) => c[0].body);
    expect(new Set(bodies).size).toBe(1);
    expect(s.marketingSchedule.rows.get(job.id)).toMatchObject({ status: 'FAILED', attempt: 3 });
    expect(post(s)).toMatchObject({ status: 'FAILED' });
  });

  it('treats 409 (already received) as delivered and other 4xx as final', async () => {
    const s1 = await seeded();
    await due(s1);
    s1.responses.push(409);
    expect((await dispatchDueSocialPosts({}, s1.deps))[0].outcome).toBe('DISPATCHED');

    const s2 = await seeded();
    await due(s2);
    s2.responses.push(400);
    expect((await dispatchDueSocialPosts({}, s2.deps))[0].outcome).toBe('FAILED');
    expect(s2.send).toHaveBeenCalledTimes(1);
  });

  it('re-validates stock right before dispatch: BLOCK fails without sending', async () => {
    const s = await seeded();
    await due(s);
    s.state.stock = 'BLOCK';
    const [r] = await dispatchDueSocialPosts({}, s.deps);
    expect(r).toMatchObject({ outcome: 'FAILED' });
    expect((r as { reason: string }).reason).toContain('stock BLOCK');
    expect(s.send).not.toHaveBeenCalled();
    expect(post(s)).toMatchObject({ status: 'FAILED' });
  });

  it('blocks when the active price changed since approval', async () => {
    const s = await seeded();
    await due(s);
    s.state.listPrice = 2299;
    const [r] = await dispatchDueSocialPosts({}, s.deps);
    expect((r as { reason: string }).reason).toMatch(/Price of product p1 changed since approval \(2499 → 2299\)/);
    expect(s.send).not.toHaveBeenCalled();
  });

  it('blocks when the approver lost ADMIN or the campaign left APPROVED', async () => {
    const s1 = await seeded();
    await due(s1);
    s1.state.admins.clear();
    expect((await dispatchDueSocialPosts({}, s1.deps))[0]).toMatchObject({ outcome: 'FAILED' });

    const s2 = await seeded();
    await due(s2);
    s2.marketingCampaign.rows.get(s2.campaign.id)!.status = 'DRAFT';
    expect(((await dispatchDueSocialPosts({}, s2.deps))[0] as { reason: string }).reason).toContain('Campaign is no longer approved');
    expect(s1.send).not.toHaveBeenCalled();
    expect(s2.send).not.toHaveBeenCalled();
  });

  it('cancels stale jobs that no longer belong to the post', async () => {
    const s = await seeded();
    const job = await due(s);
    s.socialPost.rows.get(s.postId)!.dispatchJobId = 'sp_other';
    expect(await dispatchDueSocialPosts({}, s.deps)).toEqual([{ jobId: job.id, outcome: 'CANCELLED_STALE' }]);
    expect(s.marketingSchedule.rows.get(job.id)!.status).toBe('CANCELLED');
    expect(s.send).not.toHaveBeenCalled();
  });

  it('re-sends an unacknowledged job after its lease expires, with the same bytes', async () => {
    const s = await seeded();
    const job = await due(s);
    s.responses.push(new Error('socket hang up'));
    // Simulate a crash after the claim: job DISPATCHED, post never acked.
    s.marketingSchedule.rows.get(job.id)!.maxAttempts = 5;
    await dispatchDueSocialPosts({}, s.deps);
    const row = s.marketingSchedule.rows.get(job.id)!;
    Object.assign(row, { status: 'DISPATCHED', dispatchedAt: s.deps.now() });

    expect(await dispatchDueSocialPosts({}, s.deps)).toEqual([]); // lease still valid
    s.advance(DISPATCH_LEASE_MS + 1000);
    expect((await dispatchDueSocialPosts({}, s.deps))[0].outcome).toBe('DISPATCHED');
    expect(s.send.mock.calls[0][0].body).toBe(s.send.mock.calls[1][0].body);
  });
});

// =============================================================================
describe('publish results (exactly once)', () => {
  async function dispatched(s: Seeded) {
    const { job } = await scheduled(s);
    s.advance(27 * 3600_000 + 1000);
    await dispatchDueSocialPosts({}, s.deps);
    return job!.id;
  }

  it('applies PUBLISHED once, ignores duplicates, flags a second external id', async () => {
    const s = await seeded();
    const jobId = await dispatched(s);
    expect(await recordPublishResult({ jobId, status: 'PUBLISHED', externalPostId: 'ig_1', permalink: 'https://instagram.com/p/1' }, s.deps)).toEqual({ applied: true, phase: 'PUBLISHED' });
    expect(post(s)).toMatchObject({ status: 'PUBLISHED', externalPostId: 'ig_1' });
    expect(s.marketingSchedule.rows.get(jobId)).toMatchObject({ status: 'COMPLETED', result: { externalPostId: 'ig_1' } });

    expect(await recordPublishResult({ jobId, status: 'PUBLISHED', externalPostId: 'ig_1' }, s.deps)).toMatchObject({ applied: false, reason: 'DUPLICATE' });
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(await recordPublishResult({ jobId, status: 'PUBLISHED', externalPostId: 'ig_2' }, s.deps)).toMatchObject({ applied: false, reason: 'CONFLICTING_EXTERNAL_ID' });
    spy.mockRestore();
    expect(await recordPublishResult({ jobId, status: 'FAILED', error: 'late' }, s.deps)).toMatchObject({ applied: false, reason: 'ALREADY_FINAL' });
    expect(post(s).externalPostId).toBe('ig_1');
  });

  it('ignores unknown and stale jobs; PUBLISHED needs an external id', async () => {
    const s = await seeded();
    await dispatched(s);
    expect(await recordPublishResult({ jobId: 'sp_nope', status: 'FAILED' }, s.deps)).toEqual({ applied: false, reason: 'UNKNOWN_JOB' });
    await expectError(recordPublishResult({ jobId: 'x', status: 'PUBLISHED' }, s.deps), 'INVALID_INPUT', 400);
  });

  it('FAILED then ADMIN retry uses a new generation/job; late results for the old job are stale', async () => {
    const s = await seeded();
    const oldJob = await dispatched(s);
    await recordPublishResult({ jobId: oldJob, status: 'FAILED', error: 'Token expired for owner@example.com' }, s.deps);
    expect(post(s)).toMatchObject({ status: 'FAILED' });
    expect(post(s).errorMessage).not.toContain('owner@example.com');
    await expectError(retryFailedPost(s.postId, { scheduledFor: new Date('2026-09-30T15:00:00Z') }, sales, s.deps), 'FORBIDDEN', 403);

    const retry = await retryFailedPost(s.postId, { scheduledFor: new Date('2026-09-30T15:00:00Z') }, admin, s.deps);
    expect(retry.job!.id).toBe(jobIdFor(idempotencyKeyFor(s.postId, 1, 1)));
    expect(retry.job!.id).not.toBe(oldJob);
    expect(post(s)).toMatchObject({ status: 'SCHEDULED', dispatchGeneration: 1 });

    expect(await recordPublishResult({ jobId: oldJob, status: 'PUBLISHED', externalPostId: 'ig_9' }, s.deps)).toMatchObject({ applied: false, reason: 'STALE_JOB' });
  });

  it('get / list expose derived phases', async () => {
    const s = await seeded();
    await scheduled(s);
    expect((await getSocialPost(s.postId, sales, s.deps)).phase).toBe('SCHEDULED');
    expect((await listSocialPosts({ campaignId: s.campaign.id }, sales, s.deps)).items[0].phase).toBe('SCHEDULED');
  });
});

// =============================================================================
describe('isolation', () => {
  it('publishing code writes only marketing tables; ERP access is read-only', () => {
    const dir = path.resolve(__dirname, '../src/marketing/publishing');
    const allowed = new Set(['socialPost', 'socialAccount', 'marketingSchedule', 'campaignApproval']);
    for (const file of fs.readdirSync(dir)) {
      const src = fs.readFileSync(path.join(dir, file), 'utf8');
      const writes = [...src.matchAll(/\.(\w+)\.(create|createMany|update|updateMany|upsert|delete|deleteMany)\(/g)].map((m) => m[1]);
      expect(writes.every((m) => allowed.has(m)), `${file}: ${writes}`).toBe(true);
      expect(src, file).not.toMatch(/prisma\.(user|product|stockLevel|salesOrder)\.(create|update|upsert|delete)/);
    }
  });
});
