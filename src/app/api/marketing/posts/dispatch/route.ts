import { marketingRoute } from '@/marketing/http/route';
import { runMarketingDispatchTick } from '@/marketing/scheduling/dispatcher';

export const runtime = 'nodejs';
export const maxDuration = 300;

/** ADMIN manual trigger for one dispatcher tick (social + video). The
 * scheduled trigger is the signed POST /api/marketing/webhooks/dispatch. */
export const POST = marketingRoute('schedule', () => runMarketingDispatchTick());
