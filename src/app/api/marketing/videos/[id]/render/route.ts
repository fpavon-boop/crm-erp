import { z } from 'zod';
import { marketingRoute, parseWith } from '@/marketing/http/route';
import { startRender } from '@/marketing/videos/video-service';

export const runtime = 'nodejs';

const schema = z
  .object({
    callbackUrl: z.string().url().max(2048).optional(),
    templateValues: z.record(z.union([z.string().max(2000), z.number(), z.array(z.string().max(100)).max(30), z.null()])).optional(),
  })
  .strict();

/** ADMIN: queue a render of the ADMIN-approved current version (payload goes to the dispatch outbox). */
export const POST = marketingRoute<{ id: string }>(
  'schedule',
  ({ actor, params, body }) => startRender(params.id, actor, parseWith(schema, body)),
  { status: 202 }
);
