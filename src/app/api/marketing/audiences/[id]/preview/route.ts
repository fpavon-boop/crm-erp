import { marketingRoute } from '@/marketing/http/route';
import { previewAudience } from '@/marketing/audiences/audience-service';

export const runtime = 'nodejs';

/** Estimated eligible recipients, resolved live from CRM contacts + CRM consent (read-only), with exclusion counts and a small first-name sample. */
export const GET = marketingRoute<{ id: string }>('view', ({ actor, params }) => previewAudience(params.id, actor));
