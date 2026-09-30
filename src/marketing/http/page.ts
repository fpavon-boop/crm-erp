import { notFound, redirect } from 'next/navigation';
import { requireSession } from '@/lib/session';
import { isMarketingEnabled } from '@/marketing/security/kill-switch';
import { canPerform } from '@/marketing/security/rbac';

/**
 * Server-side gate for every /marketing/* page (the UI counterpart of
 * marketingRoute): kill switch → 404, no session → /login, no marketing
 * `view` right → dashboard. `isAdmin` only decides which buttons to show;
 * every mutation goes through the API, which re-checks the role (and, for
 * ADMIN-only actions, the user's active flag) from the database.
 */

export interface MarketingViewer {
  actor: { userId: string; role: string };
  isAdmin: boolean;
}

export async function requireMarketingViewer(): Promise<MarketingViewer> {
  if (!isMarketingEnabled()) notFound();
  const session = await requireSession();
  const actor = { userId: session.user.id, role: session.user.role as string };
  if (!actor.userId || !canPerform(actor.role, 'view')) redirect('/dashboard?denied=1');
  return { actor, isAdmin: canPerform(actor.role, 'approve') };
}

/** Service 404s (MarketingError/CampaignError carry httpStatus) → Next notFound(). */
export async function orNotFound<T>(promise: Promise<T>): Promise<T> {
  try {
    return await promise;
  } catch (err) {
    if ((err as { httpStatus?: number } | null)?.httpStatus === 404) notFound();
    throw err;
  }
}

/** Reads a numeric page from searchParams (defaults to 1). */
export function pageParam(value: string | undefined): number {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : 1;
}
