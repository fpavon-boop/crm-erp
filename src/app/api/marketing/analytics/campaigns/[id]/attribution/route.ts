import { z } from 'zod';
import { marketingRoute, parseWith } from '@/marketing/http/route';
import { createAnalyticsService } from '@/marketing/analytics/service';

export const runtime = 'nodejs';

const schema = z
  .object({
    model: z.enum(['CAMPAIGN_PRODUCTS_WINDOW', 'LAST_TOUCH_WINDOW']).default('CAMPAIGN_PRODUCTS_WINDOW'),
    windowDays: z.coerce.number().int().min(1).max(365).default(30),
  })
  .strict();

/** Read-only revenue attribution from core realised orders; always `derived: true`, never finance data. */
export const GET = marketingRoute<{ id: string }>('view', ({ params, query }) =>
  createAnalyticsService().attributeRevenue(params.id, parseWith(schema, query))
);
