import { marketingRoute } from '@/marketing/http/route';
import { getAudience, updateAudience } from '@/marketing/audiences/audience-service';

export const runtime = 'nodejs';
type P = { id: string };

export const GET = marketingRoute<P>('view', ({ actor, params }) => getAudience(params.id, actor));

/** Replace the rule definition. */
export const PUT = marketingRoute<P>('draft', ({ actor, params, body }) => updateAudience(params.id, body, actor));
