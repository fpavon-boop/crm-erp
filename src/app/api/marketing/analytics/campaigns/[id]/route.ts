import { z } from 'zod';
import { marketingRoute, parseWith } from '@/marketing/http/route';
import { createAnalyticsService } from '@/marketing/analytics/service';

export const runtime = 'nodejs';

const DAY = 86_400_000;
const schema = z
  .object({
    from: z.coerce.date().optional(),
    to: z.coerce.date().optional(),
    channel: z.enum(['FACEBOOK', 'INSTAGRAM', 'TIKTOK', 'WHATSAPP', 'EMAIL', 'WEBSITE']).optional(),
  })
  .strict();

/** Performance summary (default: last 30 days); includes read-only, derived revenue attribution. */
export const GET = marketingRoute<{ id: string }>('view', ({ params, query }) => {
  const q = parseWith(schema, query);
  const to = q.to ?? new Date();
  const from = q.from ?? new Date(to.getTime() - 30 * DAY);
  return createAnalyticsService().getCampaignPerformance(params.id, { from, to, channel: q.channel });
});
