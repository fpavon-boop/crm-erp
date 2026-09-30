import { marketingRoute } from '@/marketing/http/route';
import { getVideoProject, updateVideoProject } from '@/marketing/videos/video-service';

export const runtime = 'nodejs';
type P = { id: string };

/** Project + scenes + derived phase + live platform validation. */
export const GET = marketingRoute<P>('view', ({ actor, params }) => getVideoProject(params.id, actor));

/** Edits bump the version and void any approval; locked while rendering/completed. */
export const PATCH = marketingRoute<P>('draft', ({ actor, params, body }) => updateVideoProject(params.id, body, actor));
