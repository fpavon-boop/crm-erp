import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { signedMediaUrl, verifyMediaSignature, resolvePublicAssetUrl, serveSignedMedia, MAX_MEDIA_URL_TTL_SEC } from '@/marketing/assets/signed-urls';
import { acquireMarketingLock, releaseMarketingLock } from '@/marketing/scheduling/lock';
import { runMarketingDispatchTick, DISPATCH_LOCK_ID } from '@/marketing/scheduling/dispatcher';
import { dispatchDueVideoRenders } from '@/marketing/scheduling/video-dispatch';
import { DISPATCH_LEASE_MS } from '@/marketing/scheduling/outbound';
import { handleN8nWebhook, type InboundDeps } from '@/marketing/integrations/n8n-inbound';
import { signWebhook, verifyWebhook, SIGNATURE_HEADER, TIMESTAMP_HEADER, JOB_ID_HEADER } from '@/marketing/security/signing';
import { IDEMPOTENCY_HEADER } from '@/marketing/publishing/packages';
import type { PublishingDeps } from '@/marketing/publishing/deps';
import type { VideoDeps } from '@/marketing/videos/video-service';
import { canonicalJson } from '@/marketing/videos/payload';
import { createAnalyticsService } from '@/marketing/analytics/service';
import { fakeModel } from './marketing-fixtures';

/**
 * Stage 11: signed media URLs, marketing lock, unified dispatcher (social +
 * video), and the inbound n8n webhook handler. In-memory fakes; the
 * real-Postgres pass is tests/marketing-stage11-db.test.ts.
 */

const ENV = ['MARKETING_MEDIA_URL_SECRET', 'MARKETING_PUBLIC_BASE_URL'] as const;
const saved: Record<string, string | undefined> = {};
beforeEach(() => {
  for (const k of ENV) saved[k] = process.env[k];
  process.env.MARKETING_MEDIA_URL_SECRET = 'm'.repeat(40);
  process.env.MARKETING_PUBLIC_BASE_URL = 'https://crm.example.com';
});
afterEach(() => {
  for (const k of ENV) (saved[k] === undefined ? delete process.env[k] : (process.env[k] = saved[k]));
});

const OUT_SECRET = 'o'.repeat(40);
const IN_SECRET = 'i'.repeat(40);

// =============================================================================
describe('signed media URLs', () => {
  const now = new Date('2026-09-29T12:00:00Z');
  const parts = (u: string) => {
    const url = new URL(u);
    return { id: decodeURIComponent(url.pathname.split('/').pop()!), exp: url.searchParams.get('exp'), sig: url.searchParams.get('sig') };
  };

  it('signs a time-limited URL and verifies it only for that asset and window', () => {
    const u = signedMediaUrl('asset_1', { now })!;
    expect(u).toMatch(/^https:\/\/crm\.example\.com\/api\/marketing\/public\/media\/asset_1\?exp=\d+&sig=[a-f0-9]{64}$/);
    const p = parts(u);
    expect(verifyMediaSignature('asset_1', p.exp, p.sig, now)).toBe(true);
    expect(verifyMediaSignature('asset_2', p.exp, p.sig, now)).toBe(false);
    expect(verifyMediaSignature('asset_1', String(Number(p.exp) + 1), p.sig, now)).toBe(false);
    expect(verifyMediaSignature('asset_1', p.exp, p.sig, new Date(now.getTime() + 25 * 3600_000))).toBe(false); // default 24h
    expect(verifyMediaSignature('asset_1', null, p.sig, now)).toBe(false);
  });

  it('caps lifetime and fails closed without configuration', () => {
    const p = parts(signedMediaUrl('a', { now, ttlSec: 999_999_999 })!);
    expect(Number(p.exp) - now.getTime() / 1000).toBe(MAX_MEDIA_URL_TTL_SEC);
    delete process.env.MARKETING_MEDIA_URL_SECRET;
    expect(signedMediaUrl('a')).toBeNull();
    expect(resolvePublicAssetUrl({ id: 'a', url: '/api/documents/d/download' })).toBeNull();
    expect(resolvePublicAssetUrl({ id: 'a', url: 'https://cdn.example.com/x.png' })).toBe('https://cdn.example.com/x.png');
  });

  it('resolver signs ERP-linked (relative) assets', () => {
    expect(resolvePublicAssetUrl({ id: 'a9', url: '/api/documents/d/download' })).toMatch(/\/api\/marketing\/public\/media\/a9\?exp=/);
  });

  describe('serving', () => {
    function deps() {
      const marketingAsset = fakeModel('asset', { archivedAt: null });
      const document = fakeModel('doc');
      const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
      const readFile = vi.fn(async () => Buffer.from(bytes));
      return { marketingAsset, document, readFile, bytes, d: { db: { marketingAsset, document } as never, readFile, now: () => now } };
    }
    const q = (id: string) => {
      const p = parts(signedMediaUrl(id, { now })!);
      return { exp: p.exp, sig: p.sig };
    };

    it('streams an ERP product image read-only with safe headers', async () => {
      const s = deps();
      const doc = await s.document.create({ data: { entityType: 'PRODUCT', storedPath: 'products/a.png', mimeType: 'image/png' } });
      const asset = await s.marketingAsset.create({ data: { type: 'IMAGE', source: 'ERP_DOCUMENT', sourceDocumentId: doc.id, url: `/api/documents/${doc.id}/download` } });
      const res = await serveSignedMedia(asset.id, q(asset.id), s.d);
      expect(res).toMatchObject({ status: 200, headers: { 'content-type': 'image/png', 'x-content-type-options': 'nosniff' } });
      expect((res as { body: Buffer }).body.equals(s.bytes)).toBe(true);
      expect(s.readFile).toHaveBeenCalledWith('products/a.png');
    });

    it('redirects public assets; refuses bad signatures, archived, non-media and non-product documents', async () => {
      const s = deps();
      const pub = await s.marketingAsset.create({ data: { type: 'VIDEO', source: 'N8N', url: 'https://cdn.example.com/r.mp4' } });
      expect(await serveSignedMedia(pub.id, q(pub.id), s.d)).toMatchObject({ status: 302, headers: { location: 'https://cdn.example.com/r.mp4' } });
      expect(await serveSignedMedia(pub.id, { exp: q(pub.id).exp, sig: '0'.repeat(64) }, s.d)).toMatchObject({ status: 403 });

      const old = await s.marketingAsset.create({ data: { type: 'IMAGE', source: 'CANVA', url: 'https://x/y.png', archivedAt: new Date() } });
      expect(await serveSignedMedia(old.id, q(old.id), s.d)).toMatchObject({ status: 404 });
      const pdf = await s.marketingAsset.create({ data: { type: 'DOCUMENT', source: 'UPLOAD', url: 'https://x/y.pdf' } });
      expect(await serveSignedMedia(pdf.id, q(pdf.id), s.d)).toMatchObject({ status: 404 });
      const inv = await s.document.create({ data: { entityType: 'INVOICE', storedPath: 'inv/x.png', mimeType: 'image/png' } });
      const leak = await s.marketingAsset.create({ data: { type: 'IMAGE', source: 'ERP_DOCUMENT', sourceDocumentId: inv.id, url: '/api/documents/x/download' } });
      expect(await serveSignedMedia(leak.id, q(leak.id), s.d)).toMatchObject({ status: 404 });
      expect(s.readFile).not.toHaveBeenCalled();
    });
  });
});

// =============================================================================
function world() {
  const marketingSchedule = fakeModel('job', { status: 'PENDING', attempt: 0, maxAttempts: 3, payload: null, checksum: null, dispatchedAt: null, lastError: null, idempotencyKey: null, completedAt: null, socialPostId: null });
  const videoProject = fakeModel('vp', { renderStatus: 'QUEUED', status: 'APPROVED', version: 2, approvedVersion: 2, approvedById: 'u_admin', campaignId: null, outputAssetId: null, errorMessage: null });
  const marketingCampaign = fakeModel('cmp');
  const marketingLock = fakeModel('lock', { lockedAt: null, runId: null });
  const marketingWebhookEvent = fakeModel('evt', { status: 'RECEIVED', attempts: 1, outcome: null, error: null, processedAt: null }, { unique: [['source', 'eventId']] });
  const marketingAsset = fakeModel('asset', { archivedAt: null });
  const socialPost = fakeModel('post', { dispatchedAt: null });
  const db: Record<string, unknown> = { marketingSchedule, videoProject, marketingCampaign, marketingLock, marketingWebhookEvent, marketingAsset, socialPost };
  db.$transaction = async (fn: (tx: unknown) => unknown) => fn(db);
  let clock = new Date('2026-09-29T12:00:00Z');
  const responses: Array<number | Error> = [];
  const send = vi.fn(async (_r: { url: string; headers: Record<string, string>; body: string }) => {
    const r = responses.shift() ?? 202;
    if (r instanceof Error) throw r;
    return { status: r };
  });
  const admins = new Set(['u_admin']);
  const deps = {
    db,
    send,
    signingSecret: () => OUT_SECRET,
    isActiveAdmin: async (id: string) => admins.has(id),
    webhookUrl: () => 'https://n8n.example.com/webhook/social-publish',
    videoWebhookUrl: () => 'https://n8n.example.com/webhook/video-render',
    callbackUrl: () => 'https://crm.example.com/api/marketing/webhooks/n8n',
    resolveAssetUrl: (a: { url: string }) => a.url,
    now: () => clock,
  } as unknown as PublishingDeps;
  const advance = (ms: number) => (clock = new Date(clock.getTime() + ms));
  return { db, deps, send, responses, admins, advance, marketingSchedule, videoProject, marketingCampaign, marketingLock, marketingWebhookEvent, marketingAsset, socialPost };
}

async function queuedRender(w: ReturnType<typeof world>, extra: Record<string, unknown> = {}) {
  const payload = { schema: 'marketing.video.render/v1', jobId: 'vr_1', scenes: [{ index: 1 }], checksum: 'c'.repeat(64) };
  await w.marketingSchedule.create({
    data: { id: 'vr_1', jobType: 'VIDEO_RENDER', runAt: new Date('2026-09-29T11:59:00Z'), payload, checksum: payload.checksum, idempotencyKey: 'video-render:vp:v2:a1', ...extra },
  });
  const project = await w.videoProject.create({ data: { externalJobId: 'vr_1' } });
  return { payload, project };
}

describe('marketing lock', () => {
  it('one holder at a time; stale leases are reclaimed; only the owner releases', async () => {
    const w = world();
    const t = new Date('2026-09-29T12:00:00Z');
    const a = await acquireMarketingLock(w.db as never, 'L', 60_000, t);
    expect(a).toBeTruthy();
    expect(await acquireMarketingLock(w.db as never, 'L', 60_000, new Date(t.getTime() + 1000))).toBeNull();
    await releaseMarketingLock(w.db as never, 'L', 'someone-else');
    expect(await acquireMarketingLock(w.db as never, 'L', 60_000, new Date(t.getTime() + 2000))).toBeNull();
    const b = await acquireMarketingLock(w.db as never, 'L', 60_000, new Date(t.getTime() + 61_000)); // stale
    expect(b).toBeTruthy();
    await releaseMarketingLock(w.db as never, 'L', b!);
    expect(await acquireMarketingLock(w.db as never, 'L', 60_000, new Date(t.getTime() + 62_000))).toBeTruthy();
  });
});

describe('unified dispatcher tick', () => {
  it('does nothing when MARKETING_ENABLED is off or another tick holds the lock', async () => {
    const w = world();
    await queuedRender(w);
    expect(await runMarketingDispatchTick({ enabled: () => false }, w.deps)).toEqual({ ran: false, reason: 'DISABLED' });
    await w.marketingLock.create({ data: { id: DISPATCH_LOCK_ID, lockedAt: w.deps.now(), runId: 'other' } });
    expect(await runMarketingDispatchTick({ enabled: () => true }, w.deps)).toEqual({ ran: false, reason: 'LOCKED' });
    expect(w.send).not.toHaveBeenCalled();
  });

  it('dispatches social and video jobs and always releases the lock', async () => {
    const w = world();
    await queuedRender(w);
    const r = await runMarketingDispatchTick({ enabled: () => true }, w.deps);
    expect(r).toEqual({ ran: true, social: [], video: [{ jobId: 'vr_1', outcome: 'DISPATCHED' }] });
    expect(w.marketingLock.rows.get(DISPATCH_LOCK_ID)).toMatchObject({ lockedAt: null, runId: null });
  });
});

describe('video render dispatch', () => {
  it('sends the stored payload signed, with deterministic job id and idempotency key', async () => {
    const w = world();
    const { payload } = await queuedRender(w);
    expect(await dispatchDueVideoRenders({}, w.deps)).toEqual([{ jobId: 'vr_1', outcome: 'DISPATCHED' }]);
    const req = w.send.mock.calls[0][0];
    expect(req.url).toBe('https://n8n.example.com/webhook/video-render');
    expect(req.body).toBe(canonicalJson(payload));
    expect(req.headers[JOB_ID_HEADER]).toBe('vr_1');
    expect(req.headers[IDEMPOTENCY_HEADER]).toBe('video-render:vp:v2:a1');
    expect(verifyWebhook({ rawBody: req.body, secret: OUT_SECRET, timestamp: req.headers[TIMESTAMP_HEADER], signature: req.headers[SIGNATURE_HEADER], nowMs: w.deps.now().getTime() })).toEqual({ ok: true });
    expect(w.marketingSchedule.rows.get('vr_1')).toMatchObject({ status: 'DISPATCHED', attempt: 1 });
  });

  it('retries byte-identically, re-sends after an unacknowledged lease, stops once n8n acks', async () => {
    const w = world();
    await queuedRender(w, { maxAttempts: 5 });
    w.responses.push(503);
    expect((await dispatchDueVideoRenders({}, w.deps))[0].outcome).toBe('RETRY_SCHEDULED');
    w.advance(60_000);
    expect((await dispatchDueVideoRenders({}, w.deps))[0].outcome).toBe('DISPATCHED');
    w.advance(DISPATCH_LEASE_MS + 1000); // no render.started yet → re-send
    expect((await dispatchDueVideoRenders({}, w.deps))[0].outcome).toBe('DISPATCHED');
    expect(new Set(w.send.mock.calls.map((c) => c[0].body)).size).toBe(1);

    w.videoProject.rows.forEach((p) => (p.renderStatus = 'RENDERING')); // acked
    w.advance(DISPATCH_LEASE_MS + 1000);
    expect(await dispatchDueVideoRenders({}, w.deps)).toEqual([]);
    expect(w.send).toHaveBeenCalledTimes(3);
  });

  it('fails the render (no send) when approval lapsed; final delivery failure fails the project', async () => {
    const w = world();
    await queuedRender(w);
    w.admins.clear();
    expect((await dispatchDueVideoRenders({}, w.deps))[0]).toMatchObject({ outcome: 'FAILED' });
    expect([...w.videoProject.rows.values()][0]).toMatchObject({ renderStatus: 'FAILED' });
    expect(w.send).not.toHaveBeenCalled();

    const w2 = world();
    await queuedRender(w2, { maxAttempts: 1 });
    w2.responses.push(400);
    expect((await dispatchDueVideoRenders({}, w2.deps))[0]).toMatchObject({ outcome: 'FAILED' });
    expect([...w2.videoProject.rows.values()][0].errorMessage).toMatch(/n8n dispatch failed \(400\)/);
  });

  it('cancels stale jobs and refuses corrupt payloads', async () => {
    const w = world();
    await queuedRender(w);
    w.videoProject.rows.forEach((p) => (p.externalJobId = 'vr_other'));
    expect(await dispatchDueVideoRenders({}, w.deps)).toEqual([{ jobId: 'vr_1', outcome: 'CANCELLED_STALE' }]);

    const w2 = world();
    await queuedRender(w2, { checksum: 'x'.repeat(64) });
    expect(((await dispatchDueVideoRenders({}, w2.deps))[0] as { reason: string }).reason).toContain('payload is missing or corrupt');
    expect(w2.send).not.toHaveBeenCalled();
  });
});

// =============================================================================
describe('inbound n8n webhook handler', () => {
  function inbound(w: ReturnType<typeof world>, over: Partial<InboundDeps> = {}) {
    return {
      db: w.db as never,
      publishing: w.deps,
      video: { db: w.db, now: w.deps.now } as unknown as VideoDeps,
      analytics: createAnalyticsService({ db: w.db as never, now: w.deps.now }),
      secret: () => IN_SECRET,
      enabled: () => true,
      now: w.deps.now,
      ...over,
    } satisfies InboundDeps;
  }
  const signed = (w: ReturnType<typeof world>, body: unknown, opts: { skewMs?: number; secret?: string } = {}) => {
    const rawBody = JSON.stringify(body);
    const { timestamp, signature } = signWebhook(rawBody, opts.secret ?? IN_SECRET, w.deps.now().getTime() + (opts.skewMs ?? 0));
    const h = new Headers({ [TIMESTAMP_HEADER]: timestamp, [SIGNATURE_HEADER]: signature });
    return { rawBody, headers: h };
  };

  async function scheduledPost(w: ReturnType<typeof world>) {
    await w.marketingSchedule.create({ data: { id: 'sp_1', jobType: 'SOCIAL_PUBLISH', runAt: new Date(), status: 'DISPATCHED', socialPostId: 'post_1' } });
    await w.socialPost.create({ data: { id: 'post_1', status: 'SCHEDULED', dispatchJobId: 'sp_1', externalPostId: null, dispatchedAt: new Date() } });
  }

  it('rejects when disabled, unsigned, wrongly signed, stale, or malformed', async () => {
    const w = world();
    const ev = { eventId: 'e1', type: 'render.started', jobId: 'vr_1' };
    expect((await handleN8nWebhook(signed(w, ev), inbound(w, { enabled: () => false }))).status).toBe(503);
    expect((await handleN8nWebhook({ rawBody: JSON.stringify(ev), headers: new Headers() }, inbound(w))).status).toBe(401);
    expect((await handleN8nWebhook(signed(w, ev, { secret: 'x'.repeat(40) }), inbound(w))).status).toBe(401);
    expect((await handleN8nWebhook(signed(w, ev, { skewMs: -6 * 60_000 }), inbound(w))).body).toMatchObject({ reason: 'STALE' });
    expect((await handleN8nWebhook(signed(w, { ...ev, type: 'render.exploded' }), inbound(w))).status).toBe(400);
    const bad = signed(w, ev);
    expect((await handleN8nWebhook({ rawBody: '{nope', headers: new Headers({ [TIMESTAMP_HEADER]: bad.headers.get(TIMESTAMP_HEADER)!, [SIGNATURE_HEADER]: signWebhook('{nope', IN_SECRET, w.deps.now().getTime()).signature }) }, inbound(w))).status).toBe(400);
    expect(w.marketingWebhookEvent.rows.size).toBe(0);
  });

  it('post.published is applied once; duplicate deliveries are answered from the event log', async () => {
    const w = world();
    await scheduledPost(w);
    const ev = { eventId: 'exec-1:publish', type: 'post.published', jobId: 'sp_1', data: { externalPostId: 'ig_1', permalink: 'https://instagram.com/p/1' } };
    const first = await handleN8nWebhook(signed(w, ev), inbound(w));
    expect(first).toMatchObject({ status: 200, body: { status: 'PROCESSED', outcome: { applied: true, phase: 'PUBLISHED' } } });
    expect(w.socialPost.rows.get('post_1')).toMatchObject({ status: 'PUBLISHED', externalPostId: 'ig_1', permalink: 'https://instagram.com/p/1' });

    const again = await handleN8nWebhook(signed(w, ev), inbound(w));
    expect(again).toMatchObject({ status: 200, body: { duplicate: true, status: 'PROCESSED' } });
    expect(w.marketingWebhookEvent.rows.size).toBe(1);
  });

  it('render.started → RENDERING; render.completed registers one output asset and completes the project', async () => {
    const w = world();
    const { project } = await queuedRender(w);
    await handleN8nWebhook(signed(w, { eventId: 'e-start', type: 'render.started', jobId: 'vr_1' }), inbound(w));
    expect(w.videoProject.rows.get(project.id)!.renderStatus).toBe('RENDERING');

    const done = { eventId: 'e-done', type: 'render.completed', jobId: 'vr_1', data: { url: 'https://cdn.example.com/out.mp4', width: 1080, height: 1920, durationSec: 30, sizeBytes: 12_000_000 } };
    const r = await handleN8nWebhook(signed(w, done), inbound(w));
    expect(r).toMatchObject({ status: 200, body: { status: 'PROCESSED', outcome: { outputUrl: 'https://cdn.example.com/out.mp4' } } });
    const asset = [...w.marketingAsset.rows.values()][0];
    expect(asset).toMatchObject({ source: 'N8N', externalId: 'vr_1', type: 'VIDEO', orientation: 'VERTICAL', aspectRatio: '9:16' });
    expect(w.videoProject.rows.get(project.id)).toMatchObject({ renderStatus: 'COMPLETED', outputAssetId: asset.id });

    // A second completion for the same job (new eventId) is ignored and creates no second asset.
    const dup = await handleN8nWebhook(signed(w, { ...done, eventId: 'e-done-2' }), inbound(w));
    expect(dup).toMatchObject({ status: 200, body: { status: 'IGNORED' } });
    expect(w.marketingAsset.rows.size).toBe(1);
  });

  it('unknown jobs are recorded as IGNORED; invalid render output is a 422 FAILED event', async () => {
    const w = world();
    expect(await handleN8nWebhook(signed(w, { eventId: 'e9', type: 'render.failed', jobId: 'vr_nope', data: {} }), inbound(w))).toMatchObject({
      status: 200,
      body: { status: 'IGNORED', outcome: { reason: 'UNKNOWN_JOB' } },
    });
    await queuedRender(w);
    const bad = { eventId: 'e10', type: 'render.completed', jobId: 'vr_1', data: { url: 'https://x/y.mp4', width: 100, height: 100, durationSec: 5 } };
    const r = await handleN8nWebhook(signed(w, bad), inbound(w));
    expect(r.status).toBe(422);
    expect([...w.marketingWebhookEvent.rows.values()].find((e) => e.eventId === 'e10')).toMatchObject({ status: 'FAILED' });
  });

  it('an unexpected failure is 500 and the SAME event can be retried to success', async () => {
    const w = world();
    await scheduledPost(w);
    const ev = { eventId: 'e-retry', type: 'post.failed', jobId: 'sp_1', data: { error: 'Token expired' } };
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const broken = { ...w.deps, db: { ...(w.deps.db as object), marketingSchedule: { findUnique: async () => { throw new Error('db down'); } } } } as unknown as PublishingDeps;
    expect((await handleN8nWebhook(signed(w, ev), inbound(w, { publishing: broken }))).status).toBe(500);
    spy.mockRestore();
    expect([...w.marketingWebhookEvent.rows.values()][0]).toMatchObject({ status: 'FAILED', error: 'db down' });

    const ok = await handleN8nWebhook(signed(w, ev), inbound(w));
    expect(ok).toMatchObject({ status: 200, body: { status: 'PROCESSED' } });
    expect([...w.marketingWebhookEvent.rows.values()][0]).toMatchObject({ status: 'PROCESSED', attempts: 2 });
    expect(w.socialPost.rows.get('post_1')!.status).toBe('FAILED');
  });

  it('a concurrent duplicate while the first is still processing gets 409 (retry later)', async () => {
    const w = world();
    await w.marketingWebhookEvent.create({ data: { source: 'n8n', eventId: 'busy', type: 'render.started', jobId: 'vr_1', receivedAt: w.deps.now() } });
    expect((await handleN8nWebhook(signed(w, { eventId: 'busy', type: 'render.started', jobId: 'vr_1' }), inbound(w))).status).toBe(409);
  });
});

describe('isolation', () => {
  it('Stage 11 code never writes the core IdempotencyKey or ScheduledTickLock tables', () => {
    for (const dir of ['scheduling', 'integrations']) {
      const full = path.resolve(__dirname, '../src/marketing', dir);
      for (const file of fs.readdirSync(full)) {
        const src = fs.readFileSync(path.join(full, file), 'utf8');
        expect(src, file).not.toMatch(/idempotencyKey\.(create|update|upsert)|scheduledTickLock|claimIdempotencyKey/);
      }
    }
  });
});
