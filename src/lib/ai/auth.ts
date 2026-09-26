import { NextResponse } from 'next/server';
import type { Role } from '@prisma/client';
import { requireApiModule } from '@/lib/api-auth';
import { canAccess, type Module } from '@/lib/permissions';

/**
 * Every AI route requires BOTH the `ai` module (the general "can this
 * role use AI features at all" switch) AND the specific underlying data
 * domain the feature reads from (e.g. `inventory` for product analysis,
 * `companies` for a customer summary) — the same "coarse module + finer
 * check on top" layering permissions.ts's own docstring calls for.
 * Without the second check, a role with `ai` but not (say) `inventory`
 * could use an AI route as a back door to inventory data it has no direct
 * access to. See docs/AI_FEATURES.md "Access control".
 */
export async function requireAiModule(domainModule: Module) {
  const session = await requireApiModule('ai');
  if (session instanceof NextResponse) return session;
  if (!canAccess(session.user.role as Role, domainModule)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }
  return session;
}
