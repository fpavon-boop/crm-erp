import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import crypto from 'node:crypto';
import type { TestDb } from './test-db';
import { startTestDb } from './test-db';

/**
 * Phase 12 on a REAL Postgres (local embedded): metrics arrive through the
 * signed n8n webhook, the (post, period) unique index holds, performance
 * aggregates without double-counting, and revenue attribution reads core
 * orders READ-ONLY (realised statuses, campaign products, inside the window).
 */

const IN_SECRET = 'i'.repeat(40);

describe('analytics on a real database', () => {
  let db: TestDb;
  beforeAll(async () => {
    db = await startTestDb();
    Object.assign(process.env, { DATABASE_URL: db.url, MARKETING_ENABLED: 'true', MARKETING_N8N_INBOUND_SECRET: IN_SECRET });
  }, 120000);
  afterAll(async () => {
    await db?.stop();
  });

  it('webhook ingest → performance → attribution, core untouched', async () => {
    const P = db.prisma;
    const signing = await import('../src/marketing/security/signing');
    const { POST } = await import('../src/app/api/marketing/webhooks/n8n/route');
    const { createAnalyticsService } = await import('../src/marketing/analytics/service');
    const { NextRequest } = await import('next/server');

    const product = await P.product.create({ data: { sku: `SKU-${crypto.randomUUID()}`, name: 'Oven', price: 2499 } });
    const other = await P.product.create({ data: { sku: `SKU-${crypto.randomUUID()}`, name: 'Peel', price: 40 } });
    const campaign = await P.marketingCampaign.create({ data: { name: 'Fall', status: 'PUBLISHED', productIds: [product.id], startsAt: new Date('2026-09-01T00:00:00Z') } });
    const account = await P.socialAccount.create({ data: { platform: 'INSTAGRAM', externalAccountId: `ig_${crypto.randomUUID()}` } });
    const post = await P.socialPost.create({ data: { socialAccountId: account.id, campaignId: campaign.id, status: 'PUBLISHED', permalink: 'https://instagram.com/p/1', publishedAt: new Date('2026-09-02T00:00:00Z') } });
    const job = await P.marketingSchedule.create({ data: { jobType: 'SOCIAL_PUBLISH', runAt: new Date(), socialPostId: post.id, campaignId: campaign.id, status: 'COMPLETED' } });

    // Orders: realised in window (counts), draft (no), outside window (no), other product line (no).
    const order = (status: 'CONFIRMED' | 'DELIVERED' | 'DRAFT', createdAt: string, items: Array<{ productId: string; quantity: number; unitPrice: number; discount?: number }>) =>
      P.salesOrder.create({
        data: { number: `SO-${crypto.randomUUID()}`, status, createdAt: new Date(createdAt), items: { create: items.map((i) => ({ description: 'x', discount: 0, ...i })) } },
      });
    await order('CONFIRMED', '2026-09-05T00:00:00Z', [{ productId: product.id, quantity: 1, unitPrice: 2499, discount: 99 }, { productId: other.id, quantity: 2, unitPrice: 40 }]);
    await order('DELIVERED', '2026-09-20T00:00:00Z', [{ productId: product.id, quantity: 1, unitPrice: 2499 }]);
    await order('DRAFT', '2026-09-10T00:00:00Z', [{ productId: product.id, quantity: 5, unitPrice: 2499 }]);
    await order('CONFIRMED', '2026-11-15T00:00:00Z', [{ productId: product.id, quantity: 1, unitPrice: 2499 }]);

    const send = async (event: Record<string, unknown>) => {
      const raw = JSON.stringify(event);
      const { timestamp, signature } = signing.signWebhook(raw, IN_SECRET);
      return POST(new NextRequest('http://localhost/api/marketing/webhooks/n8n', { method: 'POST', body: raw, headers: { [signing.TIMESTAMP_HEADER]: timestamp, [signing.SIGNATURE_HEADER]: signature } }));
    };
    const snap = (eventId: string, s: string, e: string, metrics: Record<string, number>, spend?: number) =>
      send({ eventId, type: 'metrics.snapshot', jobId: job.id, channel: 'INSTAGRAM', periodStart: s, periodEnd: e, metrics: { impressions: 0, reach: 0, clicks: 0, engagements: 0, videoViews: 0, conversions: 0, ...metrics }, spend });

    expect((await snap('d1', '2026-09-01T00:00:00Z', '2026-09-02T00:00:00Z', { impressions: 1000, reach: 800, clicks: 40, engagements: 100, conversions: 2 }, 50)).status).toBe(200);
    expect((await snap('d2', '2026-09-02T00:00:00Z', '2026-09-03T00:00:00Z', { impressions: 500, reach: 400, clicks: 10, engagements: 20, conversions: 1 }, 25)).status).toBe(200);
    // Lifetime snapshot overlapping the dailies — must not be added on top.
    expect((await snap('life', '2026-09-01T00:00:00Z', '2026-09-03T00:00:00Z', { impressions: 1600, reach: 1300, clicks: 55, engagements: 125, conversions: 3 }, 80)).status).toBe(200);
    // Same event redelivered → deduped by the webhook log; same period with a new event id → DUPLICATE_PERIOD.
    expect(await (await snap('d1', '2026-09-01T00:00:00Z', '2026-09-02T00:00:00Z', { impressions: 1000 })).json()).toMatchObject({ duplicate: true });
    expect(await (await snap('d1-again', '2026-09-01T00:00:00Z', '2026-09-02T00:00:00Z', { impressions: 1000, reach: 800, clicks: 40, engagements: 100, conversions: 2 }, 50)).json()).toMatchObject({
      status: 'IGNORED',
      outcome: { reason: 'DUPLICATE_PERIOD' },
    });
    expect(await P.marketingAnalytics.count({ where: { socialPostId: post.id } })).toBe(3);
    const code = await P.marketingAnalytics
      .create({ data: { socialPostId: post.id, campaignId: campaign.id, channel: 'INSTAGRAM', periodStart: new Date('2026-09-01T00:00:00Z'), periodEnd: new Date('2026-09-02T00:00:00Z') } })
      .then(() => 'OK', (e: { code?: string }) => e.code);
    expect(code).toBe('P2002');

    const coreBefore = await Promise.all([P.salesOrder.count(), P.salesOrderItem.count(), P.product.count()]);
    const svc = createAnalyticsService({ db: P, now: () => new Date('2026-10-15T00:00:00Z') });
    const perf = await svc.getCampaignPerformance(campaign.id, { from: new Date('2026-09-01T00:00:00Z'), to: new Date('2026-10-01T00:00:00Z') });

    expect(perf.totals).toEqual({ impressions: 1500, reach: 1200, clicks: 50, engagements: 120, videoViews: 0, conversions: 3, spend: 75 });
    expect(perf.attribution).toMatchObject({ derived: true, model: 'CAMPAIGN_PRODUCTS_WINDOW', windowDays: 30, orderCount: 2, revenue: 4899 });
    expect(perf.rates).toMatchObject({ ctr: 0.0333, costPerClick: 1.5, roas: 65.32 });
    expect(perf.byChannel).toEqual([expect.objectContaining({ channel: 'INSTAGRAM' })]);
    expect(perf.topPosts).toEqual([expect.objectContaining({ socialPostId: post.id, permalink: 'https://instagram.com/p/1' })]);

    const last = await svc.attributeRevenue(campaign.id, { model: 'LAST_TOUCH_WINDOW', windowDays: 7 });
    expect(last).toMatchObject({ orderCount: 1, revenue: 2400 }); // 2026-09-02 → 09-09 window
    expect(await Promise.all([P.salesOrder.count(), P.salesOrderItem.count(), P.product.count()])).toEqual(coreBefore);
  });
});
