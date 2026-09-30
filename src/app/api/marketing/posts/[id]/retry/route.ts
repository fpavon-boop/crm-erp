import { marketingRoute } from '@/marketing/http/route';
import { retryFailedPost } from '@/marketing/publishing/post-service';

export const runtime = 'nodejs';

/** ADMIN: re-schedule a FAILED post under a new dispatch generation ({ scheduledFor }). */
export const POST = marketingRoute<{ id: string }>('schedule', ({ actor, params, body }) => retryFailedPost(params.id, body, actor), { status: 201 });
