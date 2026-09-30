import { marketingRoute } from '@/marketing/http/route';
import { deleteDraftCampaign, getCampaign, updateCampaignDetails } from '@/marketing/campaigns/service';

export const runtime = 'nodejs';
type P = { id: string };

export const GET = marketingRoute<P>('view', ({ actor, params }) => getCampaign(params.id, actor));

/** Edits send the campaign back to DRAFT and clear any approval. */
export const PATCH = marketingRoute<P>('draft', ({ actor, params, body }) => updateCampaignDetails(params.id, body, actor));

/** Only never-reviewed DRAFT campaigns. */
export const DELETE = marketingRoute<P>('draft', async ({ actor, params }) => {
  await deleteDraftCampaign(params.id, actor);
});
