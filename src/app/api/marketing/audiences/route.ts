import { marketingRoute, qInt } from '@/marketing/http/route';
import { createAudience, listAudiences } from '@/marketing/audiences/audience-service';

export const runtime = 'nodejs';

export const GET = marketingRoute('view', ({ actor, query }) => listAudiences({ page: qInt(query.page), pageSize: qInt(query.pageSize) }, actor));

/** Rules only ({ name, channel: EMAIL|WHATSAPP, criteria }); no member lists are stored. */
export const POST = marketingRoute('draft', ({ actor, body }) => createAudience(body, actor), { status: 201 });
