import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import { authenticateInbound, defaultInboundDeps, processInboundEvent, type InboundDeps, type InboundResponse, type N8nEvent } from './n8n-inbound';

/**
 * Engagement metrics feedback (POST /api/marketing/webhooks/metrics).
 *
 * A post-keyed, platform-friendly payload for n8n metric sync workflows. It
 * uses the same signed-webhook contract as every n8n → CRM call —
 * `x-mkt-signature = sha256=HMAC(MARKETING_N8N_INBOUND_SECRET, "<ts>.<raw body>")`,
 * 5-minute window, kill switch — then is translated into the canonical
 * `metrics.snapshot` event and goes through the SAME replay-protected
 * pipeline as /webhooks/n8n (MarketingWebhookEvent dedupe on eventId →
 * analytics ingestSnapshot, one row per (post, period), corrections update).
 *
 * Only marketing tables are written. Unknown or unpublished posts are
 * rejected without recording anything (404 / 422: retrying won't help).
 */

const count = z.number().int().min(0).max(1e12);

export const metricsPushSchema = z
  .object({
    /** Stable per report (n8n: post + period + content hash) so retries dedupe and corrections pass. */
    eventId: z.string().trim().min(1).max(200),
    postId: z.string().trim().min(1).max(64),
    periodStart: z.string().datetime({ offset: true }),
    periodEnd: z.string().datetime({ offset: true }),
    metrics: z
      .object({
        impressions: count.optional(),
        reach: count.optional(),
        views: count.optional(),
        clicks: count.optional(),
        likes: count.optional(),
        comments: count.optional(),
        shares: count.optional(),
        saves: count.optional(),
        conversions: count.optional(),
      })
      .strict()
      .refine((m) => Object.values(m).some((v) => v != null), 'At least one metric is required'),
    spend: z.number().min(0).max(1e9).nullable().optional(),
    /** Raw platform response for audit (redacted and size-capped on ingest). */
    raw: z.unknown().optional(),
  })
  .strict();

export type MetricsPush = z.output<typeof metricsPushSchema>;

export type MetricsDb = Pick<typeof prisma, 'socialPost' | 'marketingSchedule'>;

/** Pure: platform-style counts → the CRM's MetricCounts. Engagements = likes + comments + shares + saves. */
export function toMetricCounts(m: MetricsPush['metrics']) {
  const n = (v: number | undefined) => v ?? 0;
  return {
    impressions: n(m.impressions),
    reach: n(m.reach),
    clicks: n(m.clicks),
    engagements: n(m.likes) + n(m.comments) + n(m.shares) + n(m.saves),
    videoViews: n(m.views),
    conversions: n(m.conversions),
  };
}

export async function handleMetricsWebhook(
  req: { rawBody: string; headers: { get(name: string): string | null } },
  deps: InboundDeps = defaultInboundDeps,
  db: MetricsDb = prisma
): Promise<InboundResponse> {
  const auth = authenticateInbound(req, deps);
  if (!('json' in auth)) return auth;
  const parsed = metricsPushSchema.safeParse(auth.json);
  if (!parsed.success) return { status: 400, body: { error: 'Invalid metrics payload', issues: parsed.error.flatten() } };
  const p = parsed.data;

  const post = await db.socialPost.findUnique({
    where: { id: p.postId },
    select: { id: true, status: true, dispatchJobId: true, socialAccount: { select: { platform: true } } },
  });
  if (!post) return { status: 404, body: { error: 'Unknown post', postId: p.postId } };
  if (post.status !== 'PUBLISHED') return { status: 422, body: { error: `Post is ${post.status}; metrics are only accepted for PUBLISHED posts`, postId: p.postId } };

  // Analytics are keyed by the post's publish job (see analytics ingestSnapshot).
  const jobId =
    post.dispatchJobId ??
    (await db.marketingSchedule.findFirst({ where: { socialPostId: post.id, jobType: 'SOCIAL_PUBLISH' }, orderBy: { createdAt: 'desc' }, select: { id: true } }))?.id;
  if (!jobId) return { status: 422, body: { error: 'Post has no publish job to attach metrics to', postId: p.postId } };

  const breakdown = { likes: p.metrics.likes ?? null, comments: p.metrics.comments ?? null, shares: p.metrics.shares ?? null, saves: p.metrics.saves ?? null };
  const event: N8nEvent = {
    eventId: p.eventId,
    type: 'metrics.snapshot',
    jobId,
    channel: post.socialAccount.platform,
    periodStart: p.periodStart,
    periodEnd: p.periodEnd,
    metrics: toMetricCounts(p.metrics),
    spend: p.spend ?? null,
    raw: { source: 'metrics-webhook', postId: p.postId, breakdown, ...(p.raw === undefined ? {} : { platform: p.raw }) },
  };
  return processInboundEvent(event, deps);
}
