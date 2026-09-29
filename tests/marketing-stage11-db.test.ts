import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { TestDb } from './test-db';
import { startTestDb } from './test-db';

vi.mock('next-auth', async () => {
  const actual = await vi.importActual<typeof import('next-auth')>('next-auth');
  return { ...actual, getServerSession: vi.fn(async () => null) };
});

/**
 * Stage 11 on a REAL Postgres (local embedded; never production): the
 * webhook and dispatch routes, MarketingWebhookEvent replay protection under
 * concurrent duplicate deliveries, MarketingLock contention, and the signed
 * media route reading a real core Document/file read-only. Only the n8n
 * transport and the stock/margin checks are stubbed.
 */

const IN_SECRET = 'i'.repeat(40);

describe('Stage 11 on a real database', () => {
  let db: TestDb;
  let uploads: string;
  let signing: typeof import('../src/marketing/security/signing');
  let adminId: string;

  beforeAll(async () => {
    db = await startTestDb();
    uploads = fs.mkdtempSync(path.join(os.tmpdir(), 'mkt-uploads-'));
    Object.assign(process.env, {
      DATABASE_URL: db.url,
      UPLOADS_DIR: uploads,
      MARKETING_ENABLED: 'true',
      MARKETING_N8N_INBOUND_SECRET: IN_SECRET,
      MARKETING_N8N_OUTBOUND_SECRET: 'o'.repeat(40),
      MARKETING_PUBLIC_BASE_URL: 'https://crm.example.com',
      MARKETING_MEDIA_URL_SECRET: 'm'.repeat(40),
    });
    signing = await import('../src/marketing/security/signing');
    adminId = (await db.prisma.user.create({ data: { email: 'ops@example.com', name: 'Ops', passwordHash: 'x', role: 'ADMIN' } })).id;
  }, 120000);

  afterAll(async () => {
    await db?.stop();
    fs.rmSync(uploads, { recursive: true, force: true });
  });

  const P = () => db.prisma;
  const signedRequest = async (url: string, body: unknown) => {
    const { NextRequest } = await import('next/server');
    const raw = JSON.stringify(body);
    const { timestamp, signature } = signing.signWebhook(raw, IN_SECRET);
    return new NextRequest(url, { method: 'POST', body: raw, headers: { [signing.TIMESTAMP_HEADER]: timestamp, [signing.SIGNATURE_HEADER]: signature } });
  };

  // ===========================================================================
  it('schedule → unified tick → signed n8n callback → PUBLISHED, with concurrent duplicate callbacks applied once', async () => {
    const { defaultPublishingDeps } = await import('../src/marketing/publishing/deps');
    const post = await import('../src/marketing/publishing/post-service');
    const { runMarketingDispatchTick } = await import('../src/marketing/scheduling/dispatcher');
    const pass = {
      checkInventory: async (id: string) => ({ productId: id, verdict: 'PASS' as const, issues: [], trackInventory: true, onHand: 9, draftCommitted: 0, available: 9, requiredMinimum: 3, reorderPoint: 0 }),
      checkMargin: async (id: string, pct: number) => ({ productId: id, verdict: 'PASS' as const, issues: [], listPrice: 100, discountPct: pct, promoPrice: 90, unitCost: 40, costSource: 'purchase_history' as const, marginPct: 55, minMarginPct: 25, maxDiscountPct: 40 }),
    };
    const send = vi.fn(async () => ({ status: 202 }));
    let clock = new Date();
    const deps = { ...defaultPublishingDeps, safeguards: pass, getBrand: async () => null, send, webhookUrl: () => 'https://n8n.example.com/social', now: () => clock };

    const account = await P().socialAccount.create({ data: { platform: 'FACEBOOK', externalAccountId: `fb_${crypto.randomUUID()}` } });
    const campaign = await P().marketingCampaign.create({ data: { name: 'C', status: 'APPROVED', productIds: [] } });
    const created = await post.createSocialPost({ socialAccountId: account.id, campaignId: campaign.id, caption: 'Fall ovens are here.' }, { userId: adminId, role: 'SALES' }, deps);
    await post.transitionSocialPost(created.id, 'REVIEW', { userId: adminId, role: 'SALES' }, {}, deps);
    await post.transitionSocialPost(created.id, 'APPROVED', { userId: adminId, role: 'ADMIN' }, {}, deps);
    const { job } = await post.schedulePost(created.id, { scheduledFor: new Date(clock.getTime() + 60_000) }, { userId: adminId, role: 'ADMIN' }, deps);
    clock = new Date(clock.getTime() + 120_000);

    const tick = await runMarketingDispatchTick({}, deps);
    expect(tick).toMatchObject({ ran: true, social: [{ jobId: job!.id, outcome: 'DISPATCHED' }], video: [] });
    expect(send).toHaveBeenCalledTimes(1);

    const { POST } = await import('../src/app/api/marketing/webhooks/n8n/route');
    const event = { eventId: `exec-${crypto.randomUUID()}`, type: 'post.published', jobId: job!.id, data: { externalPostId: 'fb_123', permalink: 'https://facebook.com/123' } };
    const responses = await Promise.all([1, 2, 3].map(async () => POST(await signedRequest('http://localhost/api/marketing/webhooks/n8n', event))));
    const statuses = responses.map((r) => r.status).sort();
    expect(statuses.filter((s) => s === 200).length).toBeGreaterThanOrEqual(1);
    expect(statuses.every((s) => s === 200 || s === 409)).toBe(true);

    expect(await P().marketingWebhookEvent.count({ where: { eventId: event.eventId } })).toBe(1);
    expect(await P().marketingWebhookEvent.findFirst({ where: { eventId: event.eventId } })).toMatchObject({ status: 'PROCESSED' });
    expect(await P().socialPost.findUnique({ where: { id: created.id } })).toMatchObject({ status: 'PUBLISHED', externalPostId: 'fb_123', permalink: 'https://facebook.com/123' });
    expect(await P().marketingSchedule.findUnique({ where: { id: job!.id } })).toMatchObject({ status: 'COMPLETED' });

    // Replay after processing: answered from the log, nothing re-applied.
    const replay = await POST(await signedRequest('http://localhost/api/marketing/webhooks/n8n', event));
    expect(await replay.json()).toMatchObject({ duplicate: true, status: 'PROCESSED' });

    // Unsigned / wrongly signed never reach the handler logic.
    const { NextRequest } = await import('next/server');
    expect((await POST(new NextRequest('http://localhost/api/marketing/webhooks/n8n', { method: 'POST', body: JSON.stringify(event) }))).status).toBe(401);
    expect(await P().marketingWebhookEvent.count()).toBe(1);
  });

  // ===========================================================================
  it('render callbacks: RENDERING → COMPLETED with one output asset, real (source, externalId) uniqueness', async () => {
    const campaign = await P().marketingCampaign.create({ data: { name: 'V', status: 'APPROVED', productIds: [] } });
    const jobId = `vr_${crypto.randomUUID().replace(/-/g, '').slice(0, 32)}`;
    const project = await P().videoProject.create({
      data: { title: 'Reel', campaignId: campaign.id, status: 'APPROVED', renderStatus: 'QUEUED', externalJobId: jobId, version: 1, approvedVersion: 1, approvedById: adminId },
    });
    await P().marketingSchedule.create({ data: { id: jobId, jobType: 'VIDEO_RENDER', status: 'DISPATCHED', runAt: new Date(), campaignId: campaign.id } });
    const { POST } = await import('../src/app/api/marketing/webhooks/n8n/route');
    const url = 'http://localhost/api/marketing/webhooks/n8n';

    expect((await POST(await signedRequest(url, { eventId: `${jobId}:start`, type: 'render.started', jobId }))).status).toBe(200);
    expect((await P().videoProject.findUnique({ where: { id: project.id } }))!.renderStatus).toBe('RENDERING');

    const done = { eventId: `${jobId}:done`, type: 'render.completed', jobId, data: { url: 'https://cdn.example.com/out.mp4', width: 1080, height: 1920, durationSec: 30 } };
    const res = await POST(await signedRequest(url, done));
    expect(res.status).toBe(200);
    const asset = await P().marketingAsset.findFirst({ where: { source: 'N8N', externalId: jobId } });
    expect(asset).toMatchObject({ type: 'VIDEO', aspectRatio: '9:16', url: 'https://cdn.example.com/out.mp4' });
    expect(await P().videoProject.findUnique({ where: { id: project.id } })).toMatchObject({ renderStatus: 'COMPLETED', outputAssetId: asset!.id });
    expect(await P().marketingSchedule.findUnique({ where: { id: jobId } })).toMatchObject({ status: 'COMPLETED' });

    const again = await POST(await signedRequest(url, { ...done, eventId: `${jobId}:done-retry` }));
    expect(await again.json()).toMatchObject({ status: 'IGNORED' });
    expect(await P().marketingAsset.count({ where: { source: 'N8N', externalId: jobId } })).toBe(1);
  });

  // ===========================================================================
  it('MarketingLock admits exactly one concurrent holder', async () => {
    const { acquireMarketingLock } = await import('../src/marketing/scheduling/lock');
    const now = new Date();
    const results = await Promise.all(Array.from({ length: 6 }, () => acquireMarketingLock(P(), 'contention-test', 60_000, now)));
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  // ===========================================================================
  it('dispatch route: signed n8n schedule or ADMIN only; respects the kill switch', async () => {
    const { POST } = await import('../src/app/api/marketing/webhooks/dispatch/route');
    const { NextRequest } = await import('next/server');
    const url = 'http://localhost/api/marketing/webhooks/dispatch';

    expect((await POST(new NextRequest(url, { method: 'POST', body: '{}' }))).status).toBe(401); // no signature, no session
    const ok = await POST(await signedRequest(url, {}));
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ ran: true });

    process.env.MARKETING_ENABLED = 'false';
    expect((await POST(await signedRequest(url, {}))).status).toBe(503);
    process.env.MARKETING_ENABLED = 'true';
  });

  // ===========================================================================
  it('signed media route streams a core product image read-only', async () => {
    const product = await P().product.create({ data: { sku: `SKU-${crypto.randomUUID()}`, name: 'Oven' } });
    const rel = path.join('products', `${crypto.randomUUID()}.png`);
    fs.mkdirSync(path.join(uploads, 'products'), { recursive: true });
    const bytes = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), crypto.randomBytes(64)]);
    fs.writeFileSync(path.join(uploads, rel), bytes);
    const doc = await P().document.create({
      data: { entityType: 'PRODUCT', entityId: product.id, filename: 'oven.png', storedPath: rel, mimeType: 'image/png', size: bytes.length, uploadedById: adminId },
    });
    const asset = await P().marketingAsset.create({
      data: { type: 'IMAGE', source: 'ERP_DOCUMENT', sourceDocumentId: doc.id, url: `/api/documents/${doc.id}/download`, productIds: [product.id] },
    });
    const docBefore = await P().document.findUnique({ where: { id: doc.id } });

    const { signedMediaUrl } = await import('../src/marketing/assets/signed-urls');
    const signedUrl = new URL(signedMediaUrl(asset.id)!);
    const { GET } = await import('../src/app/api/marketing/public/media/[assetId]/route');
    const { NextRequest } = await import('next/server');
    const res = await GET(new NextRequest(`http://localhost${signedUrl.pathname}${signedUrl.search}`), { params: { assetId: asset.id } });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/png');
    expect(Buffer.from(await res.arrayBuffer()).equals(bytes)).toBe(true);

    const tampered = await GET(new NextRequest(`http://localhost${signedUrl.pathname}?exp=${signedUrl.searchParams.get('exp')}&sig=${'0'.repeat(64)}`), { params: { assetId: asset.id } });
    expect(tampered.status).toBe(403);

    expect(await P().document.findUnique({ where: { id: doc.id } })).toEqual(docBefore);
    expect(fs.readFileSync(path.join(uploads, rel)).equals(bytes)).toBe(true);
  });
});
