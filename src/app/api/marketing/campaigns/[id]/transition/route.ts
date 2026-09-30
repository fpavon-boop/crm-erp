import { z } from 'zod';
import { actionForTarget, marketingRoute, parseWith } from '@/marketing/http/route';
import { transitionCampaignStatus } from '@/marketing/campaigns/service';

export const runtime = 'nodejs';

const schema = z
  .object({
    to: z.enum(['DRAFT', 'HUMAN_REVIEW', 'APPROVED', 'REJECTED', 'SCHEDULED', 'PUBLISHED', 'FAILED']),
    comment: z.string().trim().max(2000).optional(),
    acknowledgeWarnings: z.boolean().optional(),
  })
  .strict();

/** Guard checks the action for the target (approve/reject/schedule/publish are
 * ADMIN-only with a fresh DB role check); the service enforces the state
 * machine, safeguards, compliance gate and compare-and-set. */
export const POST = marketingRoute<{ id: string }>(
  (body) => actionForTarget(body),
  ({ actor, params, body }) => {
    const b = parseWith(schema, body);
    return transitionCampaignStatus(params.id, b.to, actor, { comment: b.comment, acknowledgeWarnings: b.acknowledgeWarnings });
  }
);
