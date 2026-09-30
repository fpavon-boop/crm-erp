import { marketingRoute, qInt } from '@/marketing/http/route';
import { listCampaigns } from '@/marketing/campaigns/service';
import { generateCampaignStrategy } from '@/marketing/campaigns/engine';

export const runtime = 'nodejs';
export const maxDuration = 300;

/** GET: list campaigns (view). */
export const GET = marketingRoute('view', ({ actor, query }) =>
  listCampaigns(
    { status: query.status as never, channel: query.channel as never, search: query.search, page: qInt(query.page), pageSize: qInt(query.pageSize) },
    actor
  )
);

/** POST: generate a campaign strategy (stock/margin safeguards first; AI; saved as DRAFT). */
export const POST = marketingRoute('draft', ({ actor, body }) => generateCampaignStrategy(body, actor), { status: 201 });
