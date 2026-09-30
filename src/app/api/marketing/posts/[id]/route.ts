import { marketingRoute } from '@/marketing/http/route';
import { getSocialPost, updateSocialPost } from '@/marketing/publishing/post-service';

export const runtime = 'nodejs';
type P = { id: string };

export const GET = marketingRoute<P>('view', ({ actor, params }) => getSocialPost(params.id, actor));

/** Edits bump the version and void any approval. */
export const PATCH = marketingRoute<P>('draft', ({ actor, params, body }) => updateSocialPost(params.id, body, actor));
