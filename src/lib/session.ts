import { getServerSession } from 'next-auth';
import { redirect } from 'next/navigation';
import { authOptions } from '@/lib/auth';
import type { Role } from '@prisma/client';
import { canAccess, type Module } from '@/lib/permissions';

export async function getSession() {
  return getServerSession(authOptions);
}

export async function requireSession() {
  const session = await getSession();
  if (!session?.user) {
    redirect('/login');
  }
  return session;
}

export async function requireModule(module: Module) {
  const session = await requireSession();
  const role = session.user.role as Role;
  if (!canAccess(role, module)) {
    redirect('/dashboard?denied=1');
  }
  return session;
}
