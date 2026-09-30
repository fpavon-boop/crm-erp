import { z } from 'zod';
import { actionForTarget, marketingRoute, parseWith } from '@/marketing/http/route';
import { transitionVideoProject } from '@/marketing/videos/video-service';

export const runtime = 'nodejs';

const schema = z
  .object({
    to: z.enum(['REVIEW', 'APPROVED', 'REJECTED', 'DRAFT']),
    comment: z.string().trim().max(2000).optional(),
    acknowledgeWarnings: z.boolean().optional(),
  })
  .strict();

export const POST = marketingRoute<{ id: string }>(
  (body) => actionForTarget(body),
  ({ actor, params, body }) => {
    const b = parseWith(schema, body);
    return transitionVideoProject(params.id, b.to, actor, { comment: b.comment, acknowledgeWarnings: b.acknowledgeWarnings });
  }
);
