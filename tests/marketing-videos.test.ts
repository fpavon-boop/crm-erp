import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  planInsert,
  planReorder,
  planMove,
  planRemove,
  changedAssignments,
  buildTimeline,
  SequenceError,
} from '@/marketing/videos/sequence';
import {
  validateVideoProject,
  boxForPosition,
  boxInSafeZone,
  VIDEO_PLATFORM_RULES,
  type ValidationScene,
  type ValidationAsset,
} from '@/marketing/videos/platform-rules';
import { assembleRenderPayload, canonicalJson, PayloadAssemblyError, type AssembleInput } from '@/marketing/videos/payload';
import {
  createVideoProject,
  createFromStoryboard,
  getVideoProject,
  listVideoProjects,
  updateVideoProject,
  addScene,
  updateScene,
  removeScene,
  reorderScenes,
  moveScene,
  transitionVideoProject,
  startRender,
  recordRenderEvent,
  videoPhase,
  type VideoDeps,
} from '@/marketing/videos/video-service';
import { MarketingError } from '@/marketing/errors';
import { CampaignError } from '@/marketing/campaigns/errors';
import type { InventoryStatus, MarginViability } from '@/marketing/ai/safeguards';
import { fakeModel, makeBrand } from './marketing-fixtures';

/**
 * Marketing Phase 9: video projects, scene sequencing, platform rules,
 * render payload assembly, and the ADMIN approval gate before rendering.
 */

const brand = makeBrand();
const sales = { userId: 'u_sales', role: 'SALES' };
const admin = { userId: 'u_admin', role: 'ADMIN' };

async function expectError(p: Promise<unknown>, code: string, status: number): Promise<MarketingError | CampaignError> {
  const err: MarketingError = await p.then(
    () => {
      throw new Error(`expected ${code}, but the call succeeded`);
    },
    (e: MarketingError) => e
  );
  expect(err.constructor === MarketingError || err instanceof CampaignError, String(err)).toBe(true);
  expect(err).toMatchObject({ code, httpStatus: status });
  return err;
}

// =============================================================================
describe('scene sequence math', () => {
  const cur = [
    { id: 'a', order: 1 },
    { id: 'b', order: 2 },
    { id: 'c', order: 3 },
  ];

  it('inserts at a position, shifting later scenes; appends by default', () => {
    expect(planInsert(cur, 2)).toEqual({
      position: 2,
      assignments: [
        { id: 'a', order: 1 },
        { id: 'b', order: 3 },
        { id: 'c', order: 4 },
      ],
    });
    expect(planInsert(cur).position).toBe(4);
    expect(planInsert([], undefined).position).toBe(1);
    for (const bad of [0, 5, 1.5]) expect(() => planInsert(cur, bad)).toThrow(SequenceError);
  });

  it('reorders only by an exact permutation', () => {
    expect(planReorder(cur, ['c', 'a', 'b'])).toEqual([
      { id: 'c', order: 1 },
      { id: 'a', order: 2 },
      { id: 'b', order: 3 },
    ]);
    for (const bad of [['a', 'b'], ['a', 'b', 'b'], ['a', 'b', 'x'], ['a', 'b', 'c', 'd']]) {
      expect(() => planReorder(cur, bad), bad.join()).toThrow(SequenceError);
    }
  });

  it('moves forward/backward and removes with renumbering', () => {
    expect(planMove(cur, 'a', 3).map((s) => s.id)).toEqual(['b', 'c', 'a']);
    expect(planMove(cur, 'c', 1).map((s) => s.id)).toEqual(['c', 'a', 'b']);
    expect(planRemove(cur, 'b')).toEqual([
      { id: 'a', order: 1 },
      { id: 'c', order: 2 },
    ]);
    expect(() => planMove(cur, 'zz', 1)).toThrow(SequenceError);
    expect(() => planMove(cur, 'a', 4)).toThrow(SequenceError);
  });

  it('reports only assignments that change', () => {
    expect(changedAssignments(cur, planMove(cur, 'c', 2))).toEqual([
      { id: 'c', order: 2 },
      { id: 'b', order: 3 },
    ]);
  });

  it('builds an integer-millisecond timeline without float drift', () => {
    const tl = buildTimeline(Array.from({ length: 10 }, (_, i) => ({ id: `s${i}`, order: i + 1, durationSec: 0.1 })).concat({ id: 'x', order: 11, durationSec: 0.2 }));
    expect(tl.totalMs).toBe(1200);
    expect(tl.entries.at(-1)).toEqual({ id: 'x', index: 11, startMs: 1000, endMs: 1200, durationMs: 200 });
  });
});

// =============================================================================
describe('platform rule validator', () => {
  const scene = (order: number, durationSec: number, extra: Partial<ValidationScene> = {}): ValidationScene => ({
    id: `s${order}`,
    order,
    durationSec,
    visualCue: 'Oven glowing',
    onScreenText: null,
    voiceover: null,
    assetId: null,
    textPosition: null,
    textBox: null,
    ...extra,
  });
  const project = { platform: 'TIKTOK' as const, aspectRatio: '9:16', targetDurationSec: 30, language: 'EN' as const };
  const run = (over: Partial<Parameters<typeof validateVideoProject>[0]> = {}) =>
    validateVideoProject({ project, scenes: [scene(1, 10), scene(2, 10), scene(3, 10)], assets: new Map(), ...over });
  const codes = (v: ReturnType<typeof run>) => v.issues.map((i) => `${i.severity}:${i.code}`);

  it('passes a clean 30s 9:16 TikTok', () => {
    expect(run()).toEqual({ verdict: 'PASS', issues: [], totalDurationSec: 30 });
  });

  it('enforces 9:16 and duration limits (target, platform min/max, recommended)', () => {
    expect(codes(run({ project: { ...project, aspectRatio: '16:9' } }))).toEqual(['BLOCK:ASPECT_RATIO_NOT_ALLOWED']);
    expect(codes(run({ scenes: [scene(1, 20), scene(2, 10.01)] }))).toEqual(['BLOCK:EXCEEDS_TARGET_DURATION']);
    expect(codes(run({ scenes: [scene(1, 20)] }))).toEqual(['WARN:UNDER_TARGET_DURATION']);
    expect(codes(run({ scenes: [scene(1, 2)], project: { ...project, targetDurationSec: null } }))).toEqual(['BLOCK:BELOW_PLATFORM_MINIMUM']);
    expect(codes(run({ scenes: [scene(1, 60), scene(2, 15)], project: { ...project, targetDurationSec: null } }))).toEqual(['WARN:OVER_RECOMMENDED_DURATION']);
    const fb = { ...project, platform: 'FACEBOOK_REELS' as const, targetDurationSec: null };
    expect(codes(run({ project: fb, scenes: [scene(1, 60), scene(2, 35)] }))).toEqual(['BLOCK:EXCEEDS_PLATFORM_MAXIMUM']);
    expect(codes(run({ project: { ...fb, targetDurationSec: 120 } }))).toContain('BLOCK:TARGET_EXCEEDS_PLATFORM');
  });

  it('enforces sequence integrity and per-scene duration', () => {
    expect(codes(run({ scenes: [scene(1, 10), scene(3, 10)] }))).toContain('BLOCK:SEQUENCE_BROKEN');
    expect(codes(run({ scenes: [scene(1, 10), scene(1, 10)] }))).toContain('BLOCK:SEQUENCE_BROKEN');
    expect(codes(run({ scenes: [] }))).toEqual(['BLOCK:NO_SCENES']);
    expect(codes(run({ scenes: [scene(1, 0.2), scene(2, 10)] }))).toContain('BLOCK:SCENE_DURATION_OUT_OF_RANGE');
  });

  it('checks scene visuals and assets', () => {
    const assets = new Map<string, ValidationAsset>([
      ['vert', { id: 'vert', type: 'VIDEO', orientation: 'VERTICAL', archivedAt: null, durationSec: 12 }],
      ['land', { id: 'land', type: 'VIDEO', orientation: 'LANDSCAPE', archivedAt: null, durationSec: 12 }],
      ['limg', { id: 'limg', type: 'IMAGE', orientation: 'LANDSCAPE', archivedAt: null, durationSec: null }],
      ['short', { id: 'short', type: 'VIDEO', orientation: 'VERTICAL', archivedAt: null, durationSec: 4 }],
      ['old', { id: 'old', type: 'IMAGE', orientation: 'VERTICAL', archivedAt: new Date(), durationSec: null }],
      ['aud', { id: 'aud', type: 'AUDIO', orientation: null, archivedAt: null, durationSec: 30 }],
    ]);
    const one = (s: ValidationScene) => codes(run({ assets, scenes: [s, scene(2, 10), scene(3, 10)] }));
    expect(one(scene(1, 10, { assetId: 'vert', visualCue: null }))).toEqual([]);
    expect(one(scene(1, 10, { visualCue: '  ' }))).toEqual(['BLOCK:SCENE_HAS_NO_VISUAL']);
    expect(one(scene(1, 10, { assetId: 'land' }))).toEqual(['BLOCK:ASSET_ORIENTATION_MISMATCH']);
    expect(one(scene(1, 10, { assetId: 'limg' }))).toEqual(['WARN:ASSET_ORIENTATION_MISMATCH']);
    expect(one(scene(1, 10, { assetId: 'short' }))).toEqual(['BLOCK:ASSET_TOO_SHORT']);
    expect(one(scene(1, 10, { assetId: 'old' }))).toEqual(['BLOCK:ASSET_ARCHIVED']);
    expect(one(scene(1, 10, { assetId: 'aud' }))).toEqual(['BLOCK:ASSET_TYPE_NOT_ALLOWED']);
    expect(one(scene(1, 10, { assetId: 'gone' }))).toEqual(['BLOCK:ASSET_NOT_FOUND']);
  });

  it('keeps overlay text inside the platform safe zone', () => {
    const txt = { onScreenText: 'Fire up fall' };
    const inBottomUi = { x: 0.1, y: 0.8, width: 0.6, height: 0.1 }; // bottom 22% is TikTok UI
    const underButtons = { x: 0.5, y: 0.4, width: 0.45, height: 0.1 }; // right 14% is action buttons
    const safe = { x: 0.1, y: 0.4, width: 0.6, height: 0.1 };
    const one = (s: Partial<ValidationScene>) => codes(run({ scenes: [scene(1, 10, s), scene(2, 10), scene(3, 10)] }));
    expect(one({ ...txt, textBox: inBottomUi })).toEqual(['BLOCK:OVERLAY_OUTSIDE_SAFE_ZONE']);
    expect(one({ ...txt, textBox: underButtons })).toEqual(['BLOCK:OVERLAY_OUTSIDE_SAFE_ZONE']);
    expect(one({ ...txt, textBox: safe })).toEqual([]);
    expect(one({ ...txt, textBox: { x: 0.5, y: 0.5, width: 0.6, height: 0.1 } })).toEqual(['BLOCK:OVERLAY_BOX_INVALID']);
    expect(one({ onScreenText: 'x'.repeat(100) })).toEqual(['WARN:OVERLAY_TEXT_TOO_LONG']);
    expect(one({ onScreenText: 'x'.repeat(151) })).toEqual(['BLOCK:OVERLAY_TEXT_TOO_LONG']);
    expect(codes(run({ scenes: [scene(1, 2, { onScreenText: 'one two three four five six seven eight' }), scene(2, 14), scene(3, 14)] }))).toEqual([
      'WARN:OVERLAY_READ_TIME',
    ]);
  });

  it('named positions are always inside every platform safe zone', () => {
    for (const rule of Object.values(VIDEO_PLATFORM_RULES)) {
      for (const pos of ['TOP', 'CENTER', 'BOTTOM'] as const) {
        expect(boxInSafeZone(boxForPosition(pos, rule.safeZone), rule.safeZone), `${rule.label} ${pos}`).toBe(true);
      }
    }
  });

  it('checks voiceover pacing', () => {
    const vo = (n: number) => Array.from({ length: n }, () => 'word').join(' ');
    const one = (s: Partial<ValidationScene>) => codes(run({ scenes: [scene(1, 10, s), scene(2, 10), scene(3, 10)] }));
    expect(one({ voiceover: vo(25) })).toEqual([]);
    expect(one({ voiceover: vo(29) })).toEqual(['WARN:VOICEOVER_TOO_FAST']);
    expect(one({ voiceover: vo(35) })).toEqual(['BLOCK:VOICEOVER_TOO_FAST']);
  });

  it('applies brand and compliance rules to overlays and voiceover', () => {
    const v = run({
      brand,
      approvedDiscountPct: 15,
      scenes: [scene(1, 10, { onScreenText: 'Guaranteed heat' }), scene(2, 10, { voiceover: 'Now 30% off' }), scene(3, 10, { onScreenText: '15% off this week' })],
    });
    expect(v.verdict).toBe('BLOCK');
    expect(v.issues.map((i) => [i.sceneId, i.code])).toEqual([
      ['s1', 'COPY_COMPLIANCE'],
      ['s2', 'COPY_COMPLIANCE'],
    ]);
    expect(v.issues[1].message).toContain('approved discount is 15%');
  });
});

// =============================================================================
describe('render payload assembler', () => {
  const baseInput = (): AssembleInput => ({
    jobId: 'job_1',
    project: {
      id: 'vp1',
      campaignId: 'c1',
      title: 'Fall reel',
      platform: 'TIKTOK',
      language: 'EN',
      aspectRatio: '9:16',
      targetDurationSec: 15,
      version: 3,
      approvedVersion: 3,
      approvedById: 'u_admin',
      approvedAt: new Date('2026-09-27T10:00:00Z'),
    },
    scenes: [
      { id: 's2', order: 2, durationSec: 7.5, visualCue: null, onScreenText: 'Order today', voiceover: 'Order today.', assetId: 'img', productId: 'p1', textPosition: 'BOTTOM', textBox: null, transition: 'FADE' },
      { id: 's1', order: 1, durationSec: 7.5, visualCue: 'Flames', onScreenText: null, voiceover: null, assetId: 'clip', productId: null, textPosition: null, textBox: null, transition: 'CUT' },
    ],
    assets: new Map([
      ['clip', { id: 'clip', type: 'VIDEO', url: 'https://cdn.example.com/clip.mp4', mimeType: 'video/mp4', width: 1080, height: 1920, durationSec: 10 }],
      ['img', { id: 'img', type: 'IMAGE', url: '/api/documents/doc1/download', mimeType: 'image/png', width: 1080, height: 1920, durationSec: null }],
    ]),
    template: {
      id: 't1',
      provider: 'CAPCUT',
      externalTemplateId: 'cc_42',
      placeholders: ['product_name', 'promo_price', 'discount_badge', 'cta_text'],
      declarations: [],
    },
    templateValues: { product_name: 'Tuscan Oven', promo_price: 2124.15, discount_badge: '15% OFF', cta_text: 'Shop now' },
    callbackUrl: 'https://crm.example.com/api/marketing/webhooks/n8n',
    resolveAssetUrl: (a) => (a.url.startsWith('https://') ? a.url : `https://signed.example.com${a.url}?sig=abc`),
    now: new Date('2026-09-27T12:00:00Z'),
  });

  it('produces a normalized, ordered, renderer-ready payload', () => {
    const p = assembleRenderPayload(baseInput());
    expect(p.schema).toBe('marketing.video.render/v1');
    expect(p.project).toMatchObject({ totalDurationMs: 15000, resolution: { width: 1080, height: 1920 }, fps: 30, version: 3 });
    expect(p.approval).toEqual({ approvedById: 'u_admin', approvedAt: '2026-09-27T10:00:00.000Z', approvedVersion: 3 });
    expect(p.scenes.map((s) => [s.index, s.sceneId, s.startMs, s.endMs])).toEqual([
      [1, 's1', 0, 7500],
      [2, 's2', 7500, 15000],
    ]);
    expect(p.scenes[0]).toMatchObject({ overlay: null, voiceover: null, visual: { cue: 'Flames', asset: { url: 'https://cdn.example.com/clip.mp4' } } });
    expect(p.scenes[1].visual.asset!.url).toBe('https://signed.example.com/api/documents/doc1/download?sig=abc');
    expect(p.scenes[1].overlay!.position).toBe('BOTTOM');
    expect(boxInSafeZone(p.scenes[1].overlay!.box!, VIDEO_PLATFORM_RULES.TIKTOK.safeZone)).toBe(true);
    expect(p.template).toEqual({
      id: 't1',
      provider: 'CAPCUT',
      externalTemplateId: 'cc_42',
      fields: { product_name: 'Tuscan Oven', promo_price: '$2,124.15', discount_badge: '15% OFF', cta_text: 'Shop now' },
    });
    expect(p.callback).toMatchObject({ url: 'https://crm.example.com/api/marketing/webhooks/n8n' });
    expect(p.checksum).toMatch(/^[a-f0-9]{64}$/);
  });

  it('checksum is deterministic and changes with content', () => {
    const a = assembleRenderPayload(baseInput());
    const b = assembleRenderPayload(baseInput());
    expect(b.checksum).toBe(a.checksum);
    const changed = baseInput();
    changed.scenes[0].onScreenText = 'Order now';
    expect(assembleRenderPayload(changed).checksum).not.toBe(a.checksum);
    expect(canonicalJson({ b: 1, a: { d: [2, 1], c: null } })).toBe('{"a":{"c":null,"d":[2,1]},"b":1}');
  });

  it('refuses unapproved versions, unfetchable assets and incomplete templates', () => {
    const problems = (mut: (i: AssembleInput) => void) => {
      const input = baseInput();
      mut(input);
      try {
        assembleRenderPayload(input);
        return [];
      } catch (e) {
        expect(e).toBeInstanceOf(PayloadAssemblyError);
        return (e as PayloadAssemblyError).problems;
      }
    };
    expect(problems((i) => (i.project.approvedVersion = 2))).toEqual(['Project version is not ADMIN-approved']);
    expect(problems((i) => (i.resolveAssetUrl = undefined))[0]).toMatch(/asset img has no renderer-accessible URL/);
    expect(problems((i) => delete i.templateValues!.cta_text)).toEqual(['Template field {{cta_text}} has no value']);
    expect(problems((i) => (i.templateValues!.discount_badge = 'x'.repeat(21)))[0]).toMatch(/max 20/);
  });
});

// =============================================================================
describe('video service', () => {
  function setup(opts: { inventory?: 'PASS' | 'WARN' | 'BLOCK' } = {}) {
    const videoProject = fakeModel('vp', {
      status: 'DRAFT',
      renderStatus: 'NOT_STARTED',
      version: 1,
      approvedVersion: null,
      approvedById: null,
      approvedAt: null,
      externalJobId: null,
      renderAttempts: 0,
      templateId: null,
      audioAssetId: null,
      outputAssetId: null,
      errorMessage: null,
      targetDurationSec: null,
      renderRequestedAt: null,
      renderedAt: null,
    });
    const videoScene = fakeModel(
      'sc',
      { assetId: null, visualCue: null, onScreenText: null, voiceover: null, script: null, textPosition: null, textBox: null, transition: 'CUT', productId: null },
      { unique: [['videoProjectId', 'order']] }
    );
    const marketingAsset = fakeModel('asset', { archivedAt: null });
    const marketingTemplate = fakeModel('tpl');
    const marketingCampaign = fakeModel('cmp');
    const campaignApproval = fakeModel('apr');
    const marketingSchedule = fakeModel('job');
    const db: Record<string, unknown> = { videoProject, videoScene, marketingAsset, marketingTemplate, marketingCampaign, campaignApproval, marketingSchedule };
    db.$transaction = async (fn: (tx: unknown) => unknown) => fn(db);

    const inv = vi.fn(async (id: string): Promise<InventoryStatus> => ({
      productId: id,
      verdict: opts.inventory ?? 'PASS',
      issues: opts.inventory && opts.inventory !== 'PASS' ? [{ code: 'INSUFFICIENT_STOCK', severity: opts.inventory, message: `stock ${opts.inventory}` }] : [],
      trackInventory: true,
      onHand: 10,
      draftCommitted: 0,
      available: 10,
      requiredMinimum: 3,
      reorderPoint: 0,
    }));
    const mar = vi.fn(async (id: string, pct: number): Promise<MarginViability> => ({
      productId: id,
      verdict: 'PASS',
      issues: [],
      listPrice: 2499,
      discountPct: pct,
      promoPrice: 2124.15,
      unitCost: 1000,
      costSource: 'purchase_history',
      marginPct: 52.9,
      minMarginPct: 25,
      maxDiscountPct: 46.6,
    }));
    let n = 0;
    const deps: VideoDeps = {
      db: db as never,
      safeguards: { checkInventory: inv, checkMargin: mar },
      getBrand: async () => brand,
      loadProduct: async (id) => ({ id, sku: 'TUS-48', name: 'Tuscan Oven', description: null, category: null, price: 2499 }),
      resolveAssetUrl: (a) => (a.url.startsWith('https://') ? a.url : `https://signed.example.com${a.url}`),
      newId: () => `job_${++n}`,
      now: () => new Date('2026-09-27T12:00:00Z'),
    };
    return { deps, videoProject, videoScene, marketingAsset, marketingTemplate, marketingCampaign, campaignApproval, marketingSchedule, inv };
  }

  async function seeded(opts: Parameters<typeof setup>[0] = {}) {
    const s = setup(opts);
    const campaign = await s.marketingCampaign.create({ data: { productIds: ['p1'], discountPct: 15, brandProfileId: 'bp1' } });
    const clip = await s.marketingAsset.create({ data: { type: 'VIDEO', orientation: 'VERTICAL', url: 'https://cdn.example.com/c.mp4', durationSec: 20, width: 1080, height: 1920, mimeType: 'video/mp4' } });
    const audio = await s.marketingAsset.create({ data: { type: 'AUDIO', url: 'https://cdn.example.com/a.mp3', durationSec: 30, mimeType: 'audio/mpeg' } });
    const template = await s.marketingTemplate.create({
      data: { kind: 'VIDEO', provider: 'CAPCUT', channel: 'TIKTOK', active: true, externalTemplateId: 'cc_1', placeholders: ['product_name', 'discount_badge', 'cta_text'], variables: [] },
    });
    const project = await createVideoProject({ campaignId: campaign.id, title: 'Fall reel', targetDurationSec: 30, templateId: template.id, audioAssetId: audio.id }, sales, s.deps);
    for (const [i, text] of ['Wood-fired flavor', 'Built to last', '15% off this week'].entries()) {
      await addScene(project.id, { durationSec: 10, assetId: i === 0 ? clip.id : undefined, visualCue: i === 0 ? null : 'Close-up', onScreenText: text, textPosition: 'CENTER' }, sales, {}, s.deps);
    }
    return { ...s, campaign, clip, audio, template, projectId: project.id };
  }

  const orders = async (s: Awaited<ReturnType<typeof seeded>>) =>
    (await s.videoScene.findMany({ where: { videoProjectId: s.projectId }, orderBy: { order: 'asc' } })).map((x) => x.onScreenText);

  async function approve(s: Awaited<ReturnType<typeof seeded>>) {
    await transitionVideoProject(s.projectId, 'REVIEW', sales, {}, s.deps);
    return transitionVideoProject(s.projectId, 'APPROVED', admin, {}, s.deps);
  }

  it('creates projects with platform-derived aspect ratio and checked references', async () => {
    const s = await seeded();
    const p = (await getVideoProject(s.projectId, sales, s.deps)).project;
    expect(p).toMatchObject({ aspectRatio: '9:16', platform: 'TIKTOK', status: 'DRAFT', createdById: 'u_sales' });
    await expectError(createVideoProject({ campaignId: 'nope', title: 'x' }, sales, s.deps), 'NOT_FOUND', 404);
    await expectError(createVideoProject({ campaignId: s.campaign.id, title: 'x', platform: 'FACEBOOK_REELS', targetDurationSec: 120 }, sales, s.deps), 'INVALID_INPUT', 400);
    await expectError(createVideoProject({ campaignId: s.campaign.id, title: 'x', platform: 'INSTAGRAM_REELS', templateId: s.template.id }, sales, s.deps), 'INVALID_INPUT', 400);
    await expectError(createVideoProject({ campaignId: s.campaign.id, title: 'x', audioAssetId: s.clip.id }, sales, s.deps), 'INVALID_INPUT', 400);
    expect((await listVideoProjects({ campaignId: s.campaign.id }, sales, s.deps)).items[0].phase).toBe('DRAFT');
  });

  it('builds a project from a Phase 6 storyboard in the chosen language', async () => {
    const s = await seeded();
    const res = await createFromStoryboard(
      s.campaign.id,
      {
        title: 'Fall',
        totalDurationSec: 14.5,
        scenes: [
          { order: 2, durationSec: 7, visual: 'Slice', onScreenText: { en: 'Crispy', es: 'Crujiente' }, voiceover: null },
          { order: 1, durationSec: 7.5, visual: 'Flames', onScreenText: { en: 'Hot', es: 'Caliente' }, voiceover: { en: 'Hear it', es: 'Escúchalo' } },
        ],
      },
      { language: 'ES' },
      sales,
      s.deps
    );
    expect(res.project).toMatchObject({ language: 'ES', targetDurationSec: 15, title: 'Fall (ES)' });
    expect(res.scenes.map((x) => [x.order, x.onScreenText, x.voiceover])).toEqual([
      [1, 'Caliente', 'Escúchalo'],
      [2, 'Crujiente', null],
    ]);
    expect(res.validation.totalDurationSec).toBe(14.5);
  });

  it('inserts, moves, reorders and removes scenes without breaking 1..n (unique index enforced)', async () => {
    const s = await seeded();
    await addScene(s.projectId, { durationSec: 5, visualCue: 'Logo', onScreenText: 'Intro' }, sales, { position: 1 }, s.deps);
    expect(await orders(s)).toEqual(['Intro', 'Wood-fired flavor', 'Built to last', '15% off this week']);

    const ids = (await s.videoScene.findMany({ where: { videoProjectId: s.projectId }, orderBy: { order: 'asc' } })).map((x) => x.id);
    await moveScene(ids[0], 4, sales, s.deps);
    expect(await orders(s)).toEqual(['Wood-fired flavor', 'Built to last', '15% off this week', 'Intro']);

    await reorderScenes(s.projectId, [ids[3], ids[2], ids[1], ids[0]], sales, s.deps);
    expect(await orders(s)).toEqual(['15% off this week', 'Built to last', 'Wood-fired flavor', 'Intro']);

    await removeScene(ids[2], sales, s.deps);
    const after = await s.videoScene.findMany({ where: { videoProjectId: s.projectId }, orderBy: { order: 'asc' } });
    expect(after.map((x) => [x.order, x.onScreenText])).toEqual([
      [1, '15% off this week'],
      [2, 'Wood-fired flavor'],
      [3, 'Intro'],
    ]);

    await expectError(reorderScenes(s.projectId, [ids[0], ids[0], ids[1]], sales, s.deps), 'INVALID_INPUT', 400);
    await expectError(moveScene(ids[0], 9, sales, s.deps), 'INVALID_INPUT', 400);
    await expectError(updateScene(ids[0], { assetId: s.audio.id }, sales, s.deps), 'INVALID_INPUT', 400);
    await expectError(updateScene(ids[0], { durationSec: 90 }, sales, s.deps), 'INVALID_INPUT', 400);
    // 3 seeded adds + add/move/reorder/remove = 7 edits; failed calls don't bump
    expect((await getVideoProject(s.projectId, sales, s.deps)).project.version).toBe(8);
  });

  it('submission and approval require a valid project; approval is ADMIN-only', async () => {
    const s = await seeded();
    const ids = (await s.videoScene.findMany({ where: { videoProjectId: s.projectId }, orderBy: { order: 'asc' } })).map((x) => x.id);
    await updateScene(ids[0], { durationSec: 15 }, sales, s.deps); // 35s > 30s target
    const err = await expectError(transitionVideoProject(s.projectId, 'REVIEW', sales, {}, s.deps), 'VIDEO_INVALID', 422);
    expect(err.message).toContain('exceeds the 30s target');

    await updateScene(ids[0], { durationSec: 10 }, sales, s.deps);
    await transitionVideoProject(s.projectId, 'REVIEW', sales, {}, s.deps);
    await expectError(transitionVideoProject(s.projectId, 'APPROVED', sales, {}, s.deps), 'FORBIDDEN', 403);
    await expectError(transitionVideoProject(s.projectId, 'REJECTED', admin, {}, s.deps), 'INVALID_INPUT', 400);

    const approved = await transitionVideoProject(s.projectId, 'APPROVED', admin, {}, s.deps);
    expect(approved).toMatchObject({ status: 'APPROVED', approvedById: 'u_admin', approvedVersion: approved!.version });
    expect(videoPhase(approved!)).toBe('APPROVED');
    expect(s.campaignApproval.rows.size).toBe(2);
  });

  it('warnings need acknowledgement to approve', async () => {
    const s = await seeded({ inventory: 'WARN' });
    await transitionVideoProject(s.projectId, 'REVIEW', sales, {}, s.deps);
    await expectError(transitionVideoProject(s.projectId, 'APPROVED', admin, {}, s.deps), 'WARNINGS_NOT_ACKNOWLEDGED', 422);
    const ok = await transitionVideoProject(s.projectId, 'APPROVED', admin, { acknowledgeWarnings: true }, s.deps);
    expect(ok!.status).toBe('APPROVED');
    expect([...s.campaignApproval.rows.values()].at(-1)).toMatchObject({ warningsAcknowledged: true, targetType: 'VIDEO_PROJECT' });
  });

  it('cannot render without ADMIN approval of the current version', async () => {
    const s = await seeded();
    await expectError(startRender(s.projectId, admin, {}, s.deps), 'INVALID_STATE', 409); // DRAFT
    await approve(s);
    await expectError(startRender(s.projectId, sales, {}, s.deps), 'FORBIDDEN', 403);

    // Edit after approval voids it
    const [first] = await s.videoScene.findMany({ where: { videoProjectId: s.projectId }, orderBy: { order: 'asc' } });
    await updateScene(first.id, { onScreenText: 'Real wood-fired flavor' }, sales, s.deps);
    const p = (await getVideoProject(s.projectId, sales, s.deps)).project;
    expect(p).toMatchObject({ status: 'DRAFT', approvedVersion: null, approvedById: null });
    expect([...s.campaignApproval.rows.values()].at(-1)).toMatchObject({ fromStatus: 'APPROVED', toStatus: 'DRAFT' });
    await expectError(startRender(s.projectId, admin, {}, s.deps), 'INVALID_STATE', 409);
    expect(s.marketingSchedule.rows.size).toBe(0);
  });

  it('startRender queues a payload in the outbox and locks the project', async () => {
    const s = await seeded();
    await approve(s);
    const { payload, scheduleId } = await startRender(
      s.projectId,
      admin,
      { callbackUrl: 'https://crm.example.com/cb', templateValues: { cta_text: 'Shop now', discount_badge: '90% OFF', product_name: 'Oven Pro' } },
      s.deps
    );
    expect(scheduleId).toBe('job_1');
    expect(payload.template!.fields).toEqual({ product_name: 'Oven Pro', discount_badge: '15% OFF', cta_text: 'Shop now' }); // system discount wins
    expect(payload.audio!.url).toBe('https://cdn.example.com/a.mp3');
    expect(payload.project.totalDurationMs).toBe(30000);

    const job = s.marketingSchedule.rows.get('job_1')!;
    expect(job).toMatchObject({ jobType: 'VIDEO_RENDER', status: 'PENDING', n8nWorkflow: 'video-render', campaignId: s.campaign.id });
    expect(job.payload.checksum).toBe(payload.checksum);

    const p = (await getVideoProject(s.projectId, sales, s.deps)).project;
    expect(p).toMatchObject({ renderStatus: 'QUEUED', externalJobId: 'job_1', renderAttempts: 1 });
    expect(videoPhase(p)).toBe('RENDERING');
    await expectError(updateVideoProject(s.projectId, { title: 'x' }, sales, s.deps), 'INVALID_STATE', 409);
    await expectError(startRender(s.projectId, admin, {}, s.deps), 'INVALID_STATE', 409);
  });

  it('render refused when campaign safeguards now block', async () => {
    const s = await seeded();
    await approve(s);
    s.inv.mockImplementation(async (id: string) => ({
      productId: id,
      verdict: 'BLOCK',
      issues: [{ code: 'INSUFFICIENT_STOCK', severity: 'BLOCK', message: 'sold out' }],
      trackInventory: true,
      onHand: 0,
      draftCommitted: 0,
      available: 0,
      requiredMinimum: 3,
      reorderPoint: 0,
    }));
    await expectError(startRender(s.projectId, admin, {}, s.deps), 'SAFEGUARD_BLOCKED', 422);
    expect(s.marketingSchedule.rows.size).toBe(0);
  });

  it('render callbacks: stale/duplicate/out-of-order ignored, completion needs a video asset', async () => {
    const s = await seeded();
    await approve(s);
    await startRender(s.projectId, admin, { templateValues: { cta_text: 'Shop' } }, s.deps);

    expect(await recordRenderEvent(s.projectId, { jobId: 'job_old', status: 'COMPLETED' }, s.deps)).toMatchObject({ applied: false, reason: 'STALE_JOB' });
    expect(await recordRenderEvent(s.projectId, { jobId: 'job_1', status: 'RENDERING' }, s.deps)).toMatchObject({ applied: true, phase: 'RENDERING' });
    expect(await recordRenderEvent(s.projectId, { jobId: 'job_1', status: 'RENDERING' }, s.deps)).toMatchObject({ applied: false, reason: 'DUPLICATE' });
    await expectError(recordRenderEvent(s.projectId, { jobId: 'job_1', status: 'COMPLETED', outputAssetId: s.audio.id }, s.deps), 'INVALID_INPUT', 400);

    const out = await s.marketingAsset.create({ data: { type: 'VIDEO', orientation: 'VERTICAL', url: 'https://cdn.example.com/out.mp4', durationSec: 30 } });
    expect(await recordRenderEvent(s.projectId, { jobId: 'job_1', status: 'COMPLETED', outputAssetId: out.id }, s.deps)).toMatchObject({ applied: true, phase: 'COMPLETED' });
    expect(s.marketingSchedule.rows.get('job_1')).toMatchObject({ status: 'COMPLETED' });
    expect(await recordRenderEvent(s.projectId, { jobId: 'job_1', status: 'FAILED', error: 'late' }, s.deps)).toMatchObject({ applied: false, reason: 'TERMINAL_OR_OUT_OF_ORDER' });
    expect((await getVideoProject(s.projectId, sales, s.deps)).project).toMatchObject({ renderStatus: 'COMPLETED', outputAssetId: out.id });
  });

  it('failed renders can be retried (approval still valid) or sent back to DRAFT', async () => {
    const s = await seeded();
    await approve(s);
    await startRender(s.projectId, admin, { templateValues: { cta_text: 'Shop' } }, s.deps);
    await recordRenderEvent(s.projectId, { jobId: 'job_1', status: 'FAILED', error: 'CapCut timeout; contact ops@example.com' }, s.deps);
    const failed = (await getVideoProject(s.projectId, sales, s.deps)).project;
    expect(videoPhase(failed)).toBe('FAILED');
    expect(failed.errorMessage).not.toContain('ops@example.com');

    const retry = await startRender(s.projectId, admin, { templateValues: { cta_text: 'Shop' } }, s.deps);
    expect(retry.scheduleId).toBe('job_2');
    expect((await getVideoProject(s.projectId, sales, s.deps)).project).toMatchObject({ renderAttempts: 2, externalJobId: 'job_2' });

    await recordRenderEvent(s.projectId, { jobId: 'job_2', status: 'FAILED' }, s.deps);
    const back = await transitionVideoProject(s.projectId, 'DRAFT', sales, {}, s.deps);
    expect(back).toMatchObject({ status: 'DRAFT', renderStatus: 'NOT_STARTED', approvedVersion: null });
  });
});

// =============================================================================
describe('isolation', () => {
  it('video code writes only marketing tables', () => {
    const dir = path.resolve(__dirname, '../src/marketing/videos');
    const allowed = new Set(['videoProject', 'videoScene', 'marketingSchedule', 'campaignApproval']);
    for (const file of fs.readdirSync(dir)) {
      const src = fs.readFileSync(path.join(dir, file), 'utf8');
      const writes = [...src.matchAll(/\.(\w+)\.(create|createMany|update|updateMany|upsert|delete|deleteMany)\(/g)].map((m) => m[1]);
      expect(writes.every((m) => allowed.has(m)), `${file}: ${writes}`).toBe(true);
    }
  });
});
