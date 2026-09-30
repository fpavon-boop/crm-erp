import { marketingRoute } from '@/marketing/http/route';
import { reschedulePost, schedulePost, unschedulePost } from '@/marketing/publishing/post-service';

export const runtime = 'nodejs';
type P = { id: string };

/** ADMIN: queue an APPROVED post ({ scheduledFor }); idempotent per approved version. */
export const POST = marketingRoute<P>('schedule', ({ actor, params, body }) => schedulePost(params.id, body, actor), { status: 201 });

/** ADMIN: move a not-yet-dispatched post ({ scheduledFor }). */
export const PATCH = marketingRoute<P>('schedule', ({ actor, params, body }) => reschedulePost(params.id, body, actor));

/** ADMIN: cancel a not-yet-dispatched post back to APPROVED. */
export const DELETE = marketingRoute<P>('schedule', ({ actor, params }) => unschedulePost(params.id, actor));
