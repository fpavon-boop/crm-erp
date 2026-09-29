import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { computeDerivedRates, nonOverlapping, createAnalyticsService } from '@/marketing/analytics/service';
import type { MetricsSnapshotEvent } from '@/marketing/analytics/types';
import { fakeModel } from './marketing-fixtures';

/** Phase 12 analytics: rates, overlap handling, and snapshot ingest (fakes).
 * Real-DB ingest via the webhook + attribution: tests/marketing-analytics-db.test.ts. */

const m = (over: Partial<Record<string, number>> = {}) => ({ impressions: 1000, reach: 800, clicks: 50, engagements: 120, videoViews: 0, conversions: 5, ...over });

describe('derived rates', () => {
  it('computes ratios and returns null instead of dividing by zero', () => {
    expect(computeDerivedRates({ ...m(), spend: 100 }, 400)).toEqual({
      ctr: 0.05,
      engagementRate: 0.15,
      conversionRate: 0.1,
      costPerClick: 2,
      costPerConversion: 20,
      roas: 4,
    });
    expect(computeDerivedRates({ ...m({ impressions: 0, reach: 0, clicks: 0, conversions: 0 }), spend: null })).toEqual({
      ctr: null,
      engagementRate: null,
      conversionRate: null,
      costPerClick: null,
      costPerConversion: null,
      roas: null,
    });
  });
});

describe('overlap handling', () => {
  const row = (id: string, post: string | null, s: string, e: string) => ({
    id,
    socialPostId: post,
    campaignId: 'c',
    channel: 'INSTAGRAM' as const,
    periodStart: new Date(s),
    periodEnd: new Date(e),
  });
  it('never double-counts overlapping periods for the same post', () => {
    const kept = nonOverlapping([
      row('lifetime', 'p1', '2026-09-01', '2026-09-30'),
      row('d1', 'p1', '2026-09-01', '2026-09-02'),
      row('d2', 'p1', '2026-09-02', '2026-09-03'),
      row('other', 'p2', '2026-09-01', '2026-09-30'),
    ]);
    expect(kept.map((r) => r.id).sort()).toEqual(['d1', 'd2', 'other']);
  });
});

describe('snapshot ingest', () => {
  function setup() {
    const marketingAnalytics = fakeModel('an', { spend: null, raw: null }, { unique: [['socialPostId', 'periodStart', 'periodEnd']] });
    const marketingSchedule = fakeModel('job');
    const socialPost = fakeModel('post');
    const socialAccount = fakeModel('acc');
    const marketingCampaign = fakeModel('cmp');
    const db = { marketingAnalytics, marketingSchedule, socialPost, socialAccount, marketingCampaign, salesOrderItem: fakeModel('soi') };
    const svc = createAnalyticsService({ db: db as never, now: () => new Date('2026-10-01T00:00:00Z') });
    return { svc, marketingAnalytics, marketingSchedule, socialPost, socialAccount, marketingCampaign };
  }
  async function seeded() {
    const s = setup();
    const acc = await s.socialAccount.create({ data: { platform: 'INSTAGRAM' } });
    const cmp = await s.marketingCampaign.create({ data: {} });
    const post = await s.socialPost.create({ data: { campaignId: cmp.id, socialAccountId: acc.id } });
    await s.marketingSchedule.create({ data: { id: 'sp_1', jobType: 'SOCIAL_PUBLISH', socialPostId: post.id } });
    return { ...s, cmp, post };
  }
  const ev = (over: Partial<MetricsSnapshotEvent> = {}): MetricsSnapshotEvent => ({
    eventId: 'e1',
    type: 'metrics.snapshot',
    jobId: 'sp_1',
    channel: 'FACEBOOK',
    periodStart: '2026-09-01T00:00:00Z',
    periodEnd: '2026-09-02T00:00:00Z',
    metrics: m(),
    spend: 12.5,
    ...over,
  });

  it('creates one row per post+period; the post platform wins over the reported channel', async () => {
    const s = await seeded();
    const r = await s.svc.ingestSnapshot(ev());
    expect(r).toMatchObject({ applied: true });
    const row = s.marketingAnalytics.rows.get(r.analyticsId!)!;
    expect(row).toMatchObject({ socialPostId: s.post.id, campaignId: s.cmp.id, channel: 'INSTAGRAM', clicks: 50, spend: 12.5 });
  });

  it('identical re-report is a no-op; revised numbers update in place', async () => {
    const s = await seeded();
    const first = await s.svc.ingestSnapshot(ev());
    expect(await s.svc.ingestSnapshot(ev({ eventId: 'e2' }))).toEqual({ applied: false, reason: 'DUPLICATE_PERIOD', analyticsId: first.analyticsId });
    const revised = await s.svc.ingestSnapshot(ev({ eventId: 'e3', metrics: m({ conversions: 7 }) }));
    expect(revised).toEqual({ applied: true, analyticsId: first.analyticsId });
    expect(s.marketingAnalytics.rows.size).toBe(1);
    expect(s.marketingAnalytics.rows.get(first.analyticsId!)!.conversions).toBe(7);
  });

  it('rejects unknown jobs/campaigns and impossible periods', async () => {
    const s = await seeded();
    expect(await s.svc.ingestSnapshot(ev({ jobId: 'nope' }))).toEqual({ applied: false, reason: 'UNKNOWN_JOB' });
    expect(await s.svc.ingestSnapshot(ev({ jobId: null, campaignId: 'nope' }))).toEqual({ applied: false, reason: 'UNKNOWN_JOB' });
    expect(await s.svc.ingestSnapshot(ev({ periodEnd: '2026-08-01T00:00:00Z' }))).toMatchObject({ reason: 'INVALID_PERIOD' });
    expect(await s.svc.ingestSnapshot(ev({ periodStart: '2026-11-01T00:00:00Z', periodEnd: '2026-11-02T00:00:00Z' }))).toMatchObject({ reason: 'INVALID_PERIOD' });
    await expect(s.svc.ingestSnapshot(ev({ metrics: m({ clicks: -1 }) }))).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });

  it('campaign-level (ad) metrics need an existing campaign', async () => {
    const s = await seeded();
    const r = await s.svc.ingestSnapshot(ev({ jobId: null, campaignId: s.cmp.id, channel: 'FACEBOOK' }));
    expect(s.marketingAnalytics.rows.get(r.analyticsId!)).toMatchObject({ socialPostId: null, campaignId: s.cmp.id, channel: 'FACEBOOK' });
  });

  it('stores raw payloads redacted and bounded', async () => {
    const s = await seeded();
    const a = await s.svc.ingestSnapshot(ev({ raw: { page_admin: 'owner@example.com', access_token: 'EAAabc123' } }));
    expect(JSON.stringify(s.marketingAnalytics.rows.get(a.analyticsId!)!.raw)).not.toMatch(/owner@example\.com|EAAabc123/);
    const b = await s.svc.ingestSnapshot(ev({ eventId: 'big', periodStart: '2026-09-05T00:00:00Z', periodEnd: '2026-09-06T00:00:00Z', raw: { blob: 'x'.repeat(70_000) } }));
    expect(s.marketingAnalytics.rows.get(b.analyticsId!)!.raw).toMatchObject({ truncated: true });
  });
});

describe('isolation', () => {
  it('analytics writes only MarketingAnalytics', () => {
    const src = fs.readFileSync(path.resolve(__dirname, '../src/marketing/analytics/service.ts'), 'utf8');
    const writes = [...src.matchAll(/\.(\w+)\.(create|createMany|update|updateMany|upsert|delete|deleteMany)\(/g)].map((x) => x[1]);
    expect(new Set(writes)).toEqual(new Set(['marketingAnalytics']));
  });
});
