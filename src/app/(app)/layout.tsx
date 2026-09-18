import { requireSession } from '@/lib/session';
import { MODULES, canAccess } from '@/lib/permissions';
import type { Role } from '@prisma/client';
import Sidebar from '@/components/Sidebar';
import Header from '@/components/Header';

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const session = await requireSession();
  const role = session.user.role as Role;
  const allowedModules = MODULES.filter((m) => canAccess(role, m));

  return (
    <div className="flex min-h-screen bg-slate-50">
      <Sidebar allowedModules={allowedModules} />
      <div className="flex-1 flex flex-col min-w-0">
        <Header name={session.user.name || session.user.email || 'User'} role={role} />
        <main className="flex-1 p-6 overflow-x-hidden">{children}</main>
      </div>
    </div>
  );
}
