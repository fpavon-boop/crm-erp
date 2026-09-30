import { marketingRoute } from '@/marketing/http/route';
import { updateCampaignContent } from '@/marketing/campaigns/service';

export const runtime = 'nodejs';

/** Reviewer edit: re-runs terminology/compliance, marks human-authored, returns content + campaign to DRAFT. */
export const PATCH = marketingRoute<{ id: string }>('draft', ({ actor, params, body }) => updateCampaignContent(params.id, body, actor));
