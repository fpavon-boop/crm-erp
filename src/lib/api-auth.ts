import { NextResponse } from 'next/server';
import { getServerSession, type Session } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { canAccess, type Module } from '@/lib/permissions';
import type { Role } from '@prisma/client';

/** Returns the session, or a 401 NextResponse if unauthenticated. Callers
 * should check `if (result instanceof NextResponse) return result;`. */
export async function requireApiSession(): Promise<Session | NextResponse> {
  const session = await getServerSession(authOptions);
  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  return session;
}

/** Like requireApiSession, but also enforces module-level role access. */
export async function requireApiModule(module: Module): Promise<Session | NextResponse> {
  const session = await requireApiSession();
  if (session instanceof NextResponse) return session;
  const role = session.user.role as Role;
  if (!canAccess(role, module)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }
  return session;
}

export function requireCronSecret(req: Request): NextResponse | null {
  const secret = process.env.CRON_SECRET;
  const provided = req.headers.get('x-cron-secret') || new URL(req.url).searchParams.get('secret');
  if (!secret || provided !== secret) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  return null;
}
