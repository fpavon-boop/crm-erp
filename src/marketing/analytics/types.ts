import type { MarketingChannel } from '@prisma/client';

/**
 * Phase 12 (Analytics & Metrics Engine) — interface scaffold only; no logic yet.
 *
 * Planned flow: n8n pulls platform metrics (Meta/Instagram/TikTok) on its own
 * schedule and posts signed `metrics.snapshot` events to
 * /api/marketing/webhooks/n8n → MarketingAnalytics rows (marketing-owned).
 * Revenue attribution is computed READ-ONLY from core sales orders and stored
 * as a labelled snapshot, never written back to the CRM/ERP.
 */

export interface MetricCounts {
  impressions: number;
  reach: number;
  clicks: number;
  engagements: number;
  videoViews: number;
  conversions: number;
}

/** Inbound payload from n8n for one post (or campaign) over one period. */
export interface MetricsSnapshotEvent {
  eventId: string;
  type: 'metrics.snapshot';
  /** SocialPost dispatch job id (post-level) — or null for campaign-level ad metrics. */
  jobId: string | null;
  campaignId?: string | null;
  channel: MarketingChannel;
  periodStart: string; // ISO 8601
  periodEnd: string; // ISO 8601
  metrics: MetricCounts;
  /** Ad spend in USD, if the source reports it. */
  spend?: number | null;
  /** Raw platform response, stored for audit (never trusted for math). */
  raw?: unknown;
}

export interface MetricsIngestResult {
  applied: boolean;
  reason?: 'UNKNOWN_JOB' | 'DUPLICATE_PERIOD' | 'INVALID_PERIOD';
  analyticsId?: string;
}

/** Derived ratios; null when the denominator is 0 or data is missing. */
export interface DerivedRates {
  ctr: number | null; // clicks / impressions
  engagementRate: number | null; // engagements / reach
  conversionRate: number | null; // conversions / clicks
  costPerClick: number | null; // spend / clicks
  costPerConversion: number | null; // spend / conversions
  roas: number | null; // attributedRevenue / spend
}

export type AttributionModel = 'LAST_TOUCH_WINDOW' | 'CAMPAIGN_PRODUCTS_WINDOW';

export interface AttributionOptions {
  model: AttributionModel;
  /** Days after a post/campaign start in which realised orders count. */
  windowDays: number;
}

/** Read-only revenue attribution from core orders. Always labelled as derived. */
export interface AttributedRevenue {
  derived: true;
  model: AttributionModel;
  windowDays: number;
  orderCount: number;
  revenue: number;
  productIds: string[];
  computedAt: string;
}

export interface CampaignPerformance {
  campaignId: string;
  period: { start: string; end: string };
  totals: MetricCounts & { spend: number | null };
  rates: DerivedRates;
  byChannel: Array<{ channel: MarketingChannel; totals: MetricCounts; rates: DerivedRates }>;
  topPosts: Array<{ socialPostId: string; channel: MarketingChannel; permalink: string | null; totals: MetricCounts; rates: DerivedRates }>;
  attribution: AttributedRevenue | null;
}

export interface AnalyticsQuery {
  campaignId?: string;
  channel?: MarketingChannel;
  from: Date;
  to: Date;
}

/** Service surface to implement in Phase 12. */
export interface MarketingAnalyticsService {
  ingestSnapshot(event: MetricsSnapshotEvent): Promise<MetricsIngestResult>;
  getCampaignPerformance(campaignId: string, query: Omit<AnalyticsQuery, 'campaignId'>): Promise<CampaignPerformance>;
  computeDerivedRates(totals: MetricCounts & { spend?: number | null }, attributedRevenue?: number | null): DerivedRates;
  attributeRevenue(campaignId: string, options: AttributionOptions): Promise<AttributedRevenue>;
}
