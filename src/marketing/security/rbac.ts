import type { MarketingApprovalStatus } from '@prisma/client';

/**
 * Marketing RBAC policy — pure functions, no I/O, so every rule is unit
 * testable. Server-side enforcement (session + fresh DB role check) lives in
 * ./guard.ts.
 *
 * Policy (architecture doc §6, decision 4):
 * - ADMIN: everything, and is the ONLY role that can approve, reject,
 *   schedule, publish, or manage social accounts / secrets / brand profiles.
 * - Every other role (SALES, OPERATIONS, ACCOUNTING): view, draft, and
 *   submit a draft for human review. Nothing that makes content go live.
 *
 * Kept independent of src/lib/permissions.ts on purpose: that matrix gates
 * core ERP modules and is not modified by the marketing work.
 */

export const MARKETING_ACTIONS = [
  'view',
  'draft',
  'submit_for_review',
  'approve',
  'reject',
  'schedule',
  'publish',
  'manage_accounts',
  'manage_secrets',
  'manage_brand',
] as const;

export type MarketingAction = (typeof MARKETING_ACTIONS)[number];

export const ADMIN_ONLY_ACTIONS: ReadonlySet<MarketingAction> = new Set<MarketingAction>([
  'approve',
  'reject',
  'schedule',
  'publish',
  'manage_accounts',
  'manage_secrets',
  'manage_brand',
]);

const STANDARD_ACTIONS: ReadonlySet<MarketingAction> = new Set<MarketingAction>(['view', 'draft', 'submit_for_review']);

const KNOWN_ROLES = new Set(['ADMIN', 'SALES', 'OPERATIONS', 'ACCOUNTING']);

export function isAdminOnly(action: MarketingAction): boolean {
  return ADMIN_ONLY_ACTIONS.has(action);
}

/** Unknown or missing roles get nothing (fail closed). */
export function canPerform(role: string | null | undefined, action: MarketingAction): boolean {
  if (!role || !KNOWN_ROLES.has(role)) return false;
  if (role === 'ADMIN') return true;
  return STANDARD_ACTIONS.has(action);
}

/**
 * The approval state machine. Each allowed edge names the action required to
 * take it, so role enforcement falls out of canPerform(). Notable guarantees:
 * - AI_GENERATED can never go straight to APPROVED/SCHEDULED/PUBLISHED; it
 *   must pass through HUMAN_REVIEW.
 * - Nothing transitions INTO AI_GENERATED — only the generation pipeline
 *   creates rows in that state.
 * - PUBLISHED is terminal.
 * - "Backwards to DRAFT" edges (withdraw / edit) are allowed to drafters:
 *   they only ever take content further from going live.
 */
const TRANSITIONS: Record<MarketingApprovalStatus, Partial<Record<MarketingApprovalStatus, MarketingAction>>> = {
  DRAFT: { HUMAN_REVIEW: 'submit_for_review' },
  AI_GENERATED: { HUMAN_REVIEW: 'submit_for_review', DRAFT: 'draft', REJECTED: 'reject' },
  HUMAN_REVIEW: { APPROVED: 'approve', REJECTED: 'reject', DRAFT: 'draft' },
  APPROVED: { SCHEDULED: 'schedule', PUBLISHED: 'publish', DRAFT: 'draft' },
  REJECTED: { DRAFT: 'draft' },
  SCHEDULED: { PUBLISHED: 'publish', FAILED: 'publish', APPROVED: 'schedule' },
  FAILED: { SCHEDULED: 'schedule', DRAFT: 'draft' },
  PUBLISHED: {},
};

export type TransitionCheck =
  | { ok: true; action: MarketingAction }
  | { ok: false; reason: 'INVALID_TRANSITION' | 'FORBIDDEN'; action?: MarketingAction };

export function requiredActionForTransition(
  from: MarketingApprovalStatus,
  to: MarketingApprovalStatus
): MarketingAction | null {
  return TRANSITIONS[from]?.[to] ?? null;
}

export function authorizeTransition(
  role: string | null | undefined,
  from: MarketingApprovalStatus,
  to: MarketingApprovalStatus
): TransitionCheck {
  const action = requiredActionForTransition(from, to);
  if (!action) return { ok: false, reason: 'INVALID_TRANSITION' };
  if (!canPerform(role, action)) return { ok: false, reason: 'FORBIDDEN', action };
  return { ok: true, action };
}
