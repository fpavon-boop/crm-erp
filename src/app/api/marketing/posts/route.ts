import { marketingRoute, qInt } from '@/marketing/http/route';
import { createSocialPost, listSocialPosts } from '@/marketing/publishing/post-service';

export const runtime = 'nodejs';

export const GET = marketingRoute('view', ({ actor, query }) =>
  listSocialPosts(
    { campaignId: query.campaignId, socialAccountId: query.socialAccountId, status: query.status as never, page: qInt(query.page), pageSize: qInt(query.pageSize) },
    actor
  )
);

export const POST = marketingRoute('draft', ({ actor, body }) => createSocialPost(body, actor), { status: 201 });
