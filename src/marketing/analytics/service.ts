import { z } from 'zod';
import { Prisma, type MarketingAnalytics, type MarketingChannel } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { toNumber } from '@/lib/format';
import { STOCK_HOLDING_STATUSES } from '@/lib/automations/stock';
import { Redactor } from '@/marketing/security/redaction';
import { marketingErrors } from '@/marketing/errors';
import type {
  AnalyticsQuery,
  AttributedRevenue,
  AttributionOptions,
  CampaignPerformance,
  DerivedRates,
  MarketingAnalyticsService,
  MetricCounts,
  MetricsIngestResult,
  MetricsSnapshotEvent,
} from './types';

/**
 * Phase 12 — Analytics & Metrics Engine (implements ./types.ts).
 *
 * - Ingest: n8n posts `metrics.snapshot` events (signed, deduped by the
 *   inbound webhook). Post-level snapshots are keyed by (post, period):
 *   an identical re-report is a no-op, a revised one updates in place.
 * - Performance: totals/rates/per-channel/top posts over a date range.
 *   Overlapping periods for the same post (e.g. daily + lifetime) are
 *   never double-counted: per post, only non-overlapping periods are summed.
 * - Attribution: READ-ONLY from core realised sales orders (CONFIRMED /
 *   SHIPPED / DELIVERED) for the campaign's products inside a window. A
 *   heuristic, always returned with `derived: true`; never written to the
 *   CRM/ERP and never to be read as finance figures.
 */

const MAX_PERIOD_DAYS = 400;
/** Raw platform payloads are audit-only; oversized ones are replaced by a marker. */
const MAX_RAW_BYTES = 65_536;
const DAY = 86_400_000;
const COUNT_KEYS = ['impressions', 'reach', 'clicks', 'engagements', 'videoViews', 'conversions'] as const;

type AnalyticsDb = Pick<typeof prisma, 'marketingAnalytics' | 'marketingSchedule' | 'socialPost' | 'socialAccount' | 'marketingCampaign' | 'salesOrderItem'>;

export interface AnalyticsDeps {
  db: AnalyticsDb;
  now(): Date;
}

export const defaultAnalyticsDeps: AnalyticsDeps = { db: prisma, now: () => new Date() };

const count = z.number().int().min(0).max(1e12);
export const metricsSnapshotSchema = z
  .object({
    eventId: z.string().trim().min(1).max(200),
    type: z.literal('metrics.snapshot'),
    jobId: z.string().trim().min(1).max(200).nullable(),
    campaignId: z.string().trim().min(1).max(64).nullable().optional(),
    channel: z.enum(['FACEBOOK', 'INSTAGRAM', 'TIKTOK', 'WHATSAPP', 'EMAIL', 'WEBSITE']),
    periodStart: z.string().datetime({ offset: true }),
    periodEnd: z.string().datetime({ offset: true }),
    metrics: z.object({ impressions: count, reach: count, clicks: count, engagements: count, videoViews: count, conversions: count }).strict(),
    spend: z.number().min(0).max(1e9).nullable().optional(),
    raw: z.unknown().optional(),
  })
  .strict();

// =============================================================================
// Pure helpers
// =============================================================================

const ratio = (num: number | null | undefined, den: number | null | undefined) =>
  num == null || den == null || den <= 0 ? null : Math.round((num / den) * 10000) / 10000;

export function computeDerivedRates(totals: MetricCounts & { spend?: number | null }, attributedRevenue?: number | null): DerivedRates {
  const spend = totals.spend ?? null;
  return {
    ctr: ratio(totals.clicks, totals.impressions),
    engagementRate: ratio(totals.engagements, totals.reach),
    conversionRate: ratio(totals.conversions, totals.clicks),
    costPerClick: ratio(spend, totals.clicks),
    costPerConversion: ratio(spend, totals.conversions),
    roas: ratio(attributedRevenue ?? null, spend),
  };
}

function zero(): MetricCounts {
  return { impressions: 0, reach: 0, clicks: 0, engagements: 0, videoViews: 0, conversions: 0 };
}

function add(into: MetricCounts & { spend?: number | null }, row: Pick<MarketingAnalytics, (typeof COUNT_KEYS)[number] | 'spend'>) {
  for (const k of COUNT_KEYS) into[k] += row[k];
  if (row.spend != null) into.spend = (into.spend ?? 0) + toNumber(row.spend);
}

/** Per series (post, or campaign+channel for campaign-level rows), keep only
 * periods that don't overlap an already-kept one — earliest start first,
 * shortest first on ties — so daily and lifetime snapshots never add up twice. */
export function nonOverlapping<T extends { socialPostId: string | null; campaignId: string | null; channel: MarketingChannel; periodStart: Date; periodEnd: Date }>(rows: T[]): T[] {
  const series = new Map<string, T[]>();
  for (const r of rows) {
    const key = r.socialPostId ? `p:${r.socialPostId}` : `c:${r.campaignId}:${r.channel}`;
    series.set(key, [...(series.get(key) ?? []), r]);
  }
  const kept: T[] = [];
  for (const list of series.values()) {
    list.sort((a, b) => a.periodStart.getTime() - b.periodStart.getTime() || a.periodEnd.getTime() - b.periodEnd.getTime());
    let lastEnd = -Infinity;
    for (const r of list) {
      if (r.periodStart.getTime() >= lastEnd) {
        kept.push(r);
        lastEnd = r.periodEnd.getTime();
      }
    }
  }
  return kept;
}

// =============================================================================
// Service
// =============================================================================

export function createAnalyticsService(deps: AnalyticsDeps = defaultAnalyticsDeps): MarketingAnalyticsService {
  async function ingestSnapshot(input: MetricsSnapshotEvent): Promise<MetricsIngestResult> {
    const parsed = metricsSnapshotSchema.safeParse(input);
    if (!parsed.success) throw marketingErrors.invalidInput('Invalid metrics snapshot', parsed.error.flatten());
    const e = parsed.data;
    const periodStart = new Date(e.periodStart);
    const periodEnd = new Date(e.periodEnd);
    if (periodEnd <= periodStart || periodEnd.getTime() - periodStart.getTime() > MAX_PERIOD_DAYS * DAY || periodStart > deps.now()) {
      return { applied: false, reason: 'INVALID_PERIOD' };
    }

    // Resolve what the metrics belong to.
    let socialPostId: string | null = null;
    let campaignId: string | null = null;
    let channel: MarketingChannel = e.channel;
    if (e.jobId) {
      const job = await deps.db.marketingSchedule.findUnique({ where: { id: e.jobId }, select: { jobType: true, socialPostId: true } });
      if (!job || job.jobType !== 'SOCIAL_PUBLISH' || !job.socialPostId) return { applied: false, reason: 'UNKNOWN_JOB' };
      const post = await deps.db.socialPost.findUnique({ where: { id: job.socialPostId }, select: { id: true, campaignId: true, socialAccountId: true } });
      if (!post) return { applied: false, reason: 'UNKNOWN_JOB' };
      const account = await deps.db.socialAccount.findUnique({ where: { id: post.socialAccountId }, select: { platform: true } });
      socialPostId = post.id;
      campaignId = post.campaignId;
      channel = account?.platform ?? channel; // the post's platform is authoritative
    } else {
      if (!e.campaignId) return { applied: false, reason: 'UNKNOWN_JOB' };
      const campaign = await deps.db.marketingCampaign.findUnique({ where: { id: e.campaignId }, select: { id: true } });
      if (!campaign) return { applied: false, reason: 'UNKNOWN_JOB' };
      campaignId = campaign.id;
    }

    const values = { ...e.metrics, spend: e.spend ?? null };
    const rawJson = e.raw === undefined ? null : JSON.stringify(new Redactor().redactValue(e.raw)) ?? null;
    const raw: Prisma.InputJsonValue | typeof Prisma.JsonNull =
      rawJson == null ? Prisma.JsonNull : rawJson.length > MAX_RAW_BYTES ? { truncated: true, bytes: rawJson.length } : (JSON.parse(rawJson) as Prisma.InputJsonValue);

    const existing = await deps.db.marketingAnalytics.findFirst({
      where: socialPostId ? { socialPostId, periodStart, periodEnd } : { socialPostId: null, campaignId, channel, periodStart, periodEnd },
    });
    if (existing) {
      const same = COUNT_KEYS.every((k) => existing[k] === values[k]) && (existing.spend == null ? values.spend == null : toNumber(existing.spend) === values.spend);
      if (same) return { applied: false, reason: 'DUPLICATE_PERIOD', analyticsId: existing.id };
      const updated = await deps.db.marketingAnalytics.update({ where: { id: existing.id }, data: { ...values, raw, capturedAt: deps.now() } });
      return { applied: true, analyticsId: updated.id };
    }
    try {
      const row = await deps.db.marketingAnalytics.create({
        data: { socialPostId, campaignId, channel, periodStart, periodEnd, ...values, raw, capturedAt: deps.now() },
      });
      return { applied: true, analyticsId: row.id };
    } catch (err) {
      // Concurrent identical report won the (post, period) unique race.
      if ((err as { code?: string }).code === 'P2002') return { applied: false, reason: 'DUPLICATE_PERIOD' };
      throw err;
    }
  }

  async function attributeRevenue(campaignId: string, options: AttributionOptions): Promise<AttributedRevenue> {
    const windowDays = Math.max(1, Math.min(365, Math.floor(options.windowDays)));
    const campaign = await deps.db.marketingCampaign.findUnique({
      where: { id: campaignId },
      select: { productIds: true, startsAt: true, approvedAt: true, createdAt: true },
    });
    if (!campaign) throw marketingErrors.notFound('Campaign', campaignId);

    let start: Date | null = campaign.startsAt ?? campaign.approvedAt ?? campaign.createdAt;
    if (options.model === 'LAST_TOUCH_WINDOW') {
      const last = await deps.db.socialPost.findFirst({
        where: { campaignId, status: 'PUBLISHED', publishedAt: { not: null } },
        orderBy: { publishedAt: 'desc' },
        select: { publishedAt: true },
      });
      start = last?.publishedAt ?? null;
    }
    const now = deps.now();
    const base = { derived: true as const, model: options.model, windowDays, productIds: campaign.productIds, computedAt: now.toISOString() };
    if (!start || !campaign.productIds.length) return { ...base, orderCount: 0, revenue: 0 };

    const end = new Date(Math.min(start.getTime() + windowDays * DAY, now.getTime()));
    // Read-only core query: realised orders, campaign products only.
    const lines = await deps.db.salesOrderItem.findMany({
      where: {
        productId: { in: campaign.productIds },
        salesOrder: { status: { in: Array.from(STOCK_HOLDING_STATUSES) }, createdAt: { gte: start, lte: end } },
      },
      select: { salesOrderId: true, quantity: true, unitPrice: true, discount: true },
    });
    const revenue = lines.reduce((sum, l) => sum + toNumber(l.quantity) * toNumber(l.unitPrice) - toNumber(l.discount), 0);
    return { ...base, orderCount: new Set(lines.map((l) => l.salesOrderId)).size, revenue: Math.round(revenue * 100) / 100 };
  }

  async function getCampaignPerformance(campaignId: string, query: Omit<AnalyticsQuery, 'campaignId'>, attribution?: AttributionOptions): Promise<CampaignPerformance> {
    if (!(query.from < query.to)) throw marketingErrors.invalidInput('from must be before to');
    const rows = await deps.db.marketingAnalytics.findMany({
      where: { campaignId, periodStart: { gte: query.from }, periodEnd: { lte: query.to }, ...(query.channel ? { channel: query.channel } : {}) },
    });
    const kept = nonOverlapping(rows);

    const totals: MetricCounts & { spend: number | null } = { ...zero(), spend: null };
    const byChannel = new Map<MarketingChannel, MetricCounts & { spend?: number | null }>();
    const byPost = new Map<string, { channel: MarketingChannel; totals: MetricCounts & { spend?: number | null } }>();
    for (const r of kept) {
      add(totals, r);
      const ch = byChannel.get(r.channel) ?? { ...zero(), spend: null };
      add(ch, r);
      byChannel.set(r.channel, ch);
      if (r.socialPostId) {
        const p = byPost.get(r.socialPostId) ?? { channel: r.channel, totals: { ...zero(), spend: null } };
        add(p.totals, r);
        byPost.set(r.socialPostId, p);
      }
    }

    const attributed = attribution ? await attributeRevenue(campaignId, attribution) : null;
    const topIds = [...byPost.entries()].sort((a, b) => b[1].totals.engagements - a[1].totals.engagements).slice(0, 5);
    const permalinks = topIds.length
      ? await deps.db.socialPost.findMany({ where: { id: { in: topIds.map(([id]) => id) } }, select: { id: true, permalink: true } })
      : [];
    const link = new Map(permalinks.map((p) => [p.id, p.permalink]));
    const strip = (t: MetricCounts & { spend?: number | null }): MetricCounts => {
      const { spend: _s, ...counts } = t;
      return counts;
    };

    return {
      campaignId,
      period: { start: query.from.toISOString(), end: query.to.toISOString() },
      totals,
      rates: computeDerivedRates(totals, attributed?.revenue ?? null),
      byChannel: [...byChannel.entries()].map(([channel, t]) => ({ channel, totals: strip(t), rates: computeDerivedRates(t) })),
      topPosts: topIds.map(([socialPostId, p]) => ({
        socialPostId,
        channel: p.channel,
        permalink: link.get(socialPostId) ?? null,
        totals: strip(p.totals),
        rates: computeDerivedRates(p.totals),
      })),
      attribution: attributed,
    };
  }

  return {
    ingestSnapshot,
    getCampaignPerformance: (id, q) => getCampaignPerformance(id, q, { model: 'CAMPAIGN_PRODUCTS_WINDOW', windowDays: 30 }),
    computeDerivedRates,
    attributeRevenue,
  };
}
