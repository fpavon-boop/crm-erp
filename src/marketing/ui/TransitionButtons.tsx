import type { MarketingApprovalStatus } from '@prisma/client';
import { canPerform, requiredActionForTransition } from '@/marketing/security/rbac';
import ApiButton from './ApiButton';

/**
 * Renders one button per state-machine edge the viewer's role may take from
 * `status`, derived from the same rbac.ts table the server enforces, so the
 * UI can never offer an edge the API would refuse on role grounds.
 */

const LABELS: Partial<Record<MarketingApprovalStatus, { label: string; variant: 'primary' | 'secondary' | 'danger'; comment?: boolean | 'required'; confirm?: string }>> = {
  HUMAN_REVIEW: { label: 'Submit for review', variant: 'primary' },
  APPROVED: { label: 'Approve', variant: 'primary', comment: true },
  REJECTED: { label: 'Reject', variant: 'danger', comment: 'required' },
  SCHEDULED: { label: 'Mark scheduled', variant: 'primary' },
  PUBLISHED: { label: 'Mark published', variant: 'secondary', confirm: 'Mark as PUBLISHED? This is final.' },
  DRAFT: { label: 'Back to draft', variant: 'secondary' },
};

/** Posts and videos use REVIEW on the wire where campaigns use HUMAN_REVIEW. */
export default function TransitionButtons({
  status,
  role,
  url,
  targets,
  reviewAlias,
  warnVerdict,
}: {
  status: MarketingApprovalStatus;
  role: string;
  url: string;
  /** Edges this resource's API accepts (subset of the full state machine). */
  targets: MarketingApprovalStatus[];
  reviewAlias?: 'REVIEW';
  /** When the live safeguard/validation verdict is WARN, approval sends acknowledgeWarnings after a confirm. */
  warnVerdict?: boolean;
}) {
  const edges = targets.filter((to) => {
    const action = requiredActionForTransition(status, to);
    return action != null && canPerform(role, action);
  });
  if (edges.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-2 items-start">
      {edges.map((to) => {
        const l = LABELS[to] ?? { label: to, variant: 'secondary' as const };
        const wire = to === 'HUMAN_REVIEW' && reviewAlias ? reviewAlias : to;
        const ack = to === 'APPROVED' && warnVerdict;
        return (
          <ApiButton
            key={to}
            label={l.label}
            url={url}
            variant={l.variant}
            askComment={l.comment}
            body={{ to: wire, ...(ack ? { acknowledgeWarnings: true } : {}) }}
            confirmText={ack ? 'Safeguards returned WARNINGS. Approve anyway and record that you acknowledged them?' : l.confirm}
          />
        );
      })}
    </div>
  );
}
