import { prisma } from '@/lib/prisma';
import { requireModule } from '@/lib/session';
import PageHeader from '@/components/PageHeader';
import UsersClient from './UsersClient';

export default async function UsersPage() {
  const session = await requireModule('users');
  const users = await prisma.user.findMany({
    select: { id: true, name: true, email: true, role: true, active: true },
    orderBy: { name: 'asc' },
  });

  return (
    <div>
      <PageHeader title="Users & Roles" subtitle={`${users.length} users`} />
      <UsersClient initial={users} currentUserId={session.user.id} />
    </div>
  );
}
