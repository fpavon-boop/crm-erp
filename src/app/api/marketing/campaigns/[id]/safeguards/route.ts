import { marketingRoute } from '@/marketing/http/route';
import { getCampaignSafeguards } from '@/marketing/campaigns/service';

export const runtime = 'nodejs';

/** Read-only stock + margin evaluation for the campaign's products at its discount. */
export const GET = marketingRoute<{ id: string }>('view', ({ actor, params }) => getCampaignSafeguards(params.id, actor));
