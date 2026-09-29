import { NextResponse } from 'next/server';
import type { MarketingApprovalStatus } from '@prisma/client';
import { requireApiSession } from '@/lib/api-auth';
import { prisma } from '@/lib/prisma';
import { isMarketingEnabled } from './kill-switch';
import { authorizeTransition, canPerform, isAdminOnly, requiredActionForTransition, type MarketingAction } from './rbac';

/**
 * Route-level enforcement for marketing API handlers. Usage:
 *
 *   const ctx = await requireMarketingAction('approve');
 *   if (ctx instanceof NextResponse) return ctx;
 *
 * Layers, in order:
 * 1. Kill switch — MARKETING_ENABLED must be exactly "true" (503 otherwise).
 * 2. Authenticated NextAuth session (existing requireApiSession, unchanged).
 * 3. Role policy from ./rbac.ts against the session's role.
 * 4. For ADMIN-only actions, a fresh read of the user's role/active flag from
 *    the database. JWT sessions live 12h, so a user demoted or deactivated
 *    after login would otherwise keep publishing rights until expiry.
 *    Read-only: this never writes to the User table.
 */

export interface MarketingAuthContext {
  userId: string;
  role: string;
}

function forbidden() {
  return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
}

export { isMarketingEnabled };

export async function requireMarketingAction(action: MarketingAction): Promise<MarketingAuthContext | NextResponse> {
  if (!isMarketingEnabled()) {
    return NextResponse.json({ error: 'Marketing module is disabled' }, { status: 503 });
  }

  const session = await requireApiSession();
  if (session instanceof NextResponse) return session;

  const userId = session.user.id;
  const role = session.user.role;
  if (!userId || !canPerform(role, action)) return forbidden();

  if (isAdminOnly(action)) {
    const user = await prisma.user.findUnique({ where: { id: userId }, select: { role: true, active: true } });
    if (!user || !user.active || !canPerform(user.role, action)) return forbidden();
    return { userId, role: user.role };
  }

  return { userId, role };
}

/** Enforces both the state machine and the role for a status change. Returns
 * 409 for an edge that doesn't exist, 403 for one the role can't take. */
export async function requireMarketingTransition(
  from: MarketingApprovalStatus,
  to: MarketingApprovalStatus
): Promise<(MarketingAuthContext & { action: MarketingAction }) | NextResponse> {
  const action = requiredActionForTransition(from, to);
  if (!action) {
    return NextResponse.json({ error: `Invalid status transition ${from} -> ${to}` }, { status: 409 });
  }
  const ctx = await requireMarketingAction(action);
  if (ctx instanceof NextResponse) return ctx;
  if (!authorizeTransition(ctx.role, from, to).ok) return forbidden();
  return { ...ctx, action };
}
