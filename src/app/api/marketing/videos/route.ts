import { marketingRoute, qInt } from '@/marketing/http/route';
import { createVideoProject, listVideoProjects } from '@/marketing/videos/video-service';

export const runtime = 'nodejs';

export const GET = marketingRoute('view', ({ actor, query }) =>
  listVideoProjects({ campaignId: query.campaignId, platform: query.platform as never, page: qInt(query.page), pageSize: qInt(query.pageSize) }, actor)
);

export const POST = marketingRoute('draft', ({ actor, body }) => createVideoProject(body, actor), { status: 201 });
