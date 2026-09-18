import { prisma } from '@/lib/prisma';
import { requireModule, requireSession } from '@/lib/session';
import PageHeader from '@/components/PageHeader';
import AccountsClient from './AccountsClient';

export default async function EmailAccountsPage() {
  await requireModule('inbox');
  const session = await requireSession();
  const accounts = await prisma.emailAccount.findMany({
    where: { userId: session.user.id },
    select: { id: true, label: true, emailAddress: true, imapHost: true, smtpHost: true, active: true, lastSyncedAt: true },
  });

  return (
    <div>
      <PageHeader title="Email Accounts" subtitle="Connect mailboxes for the shared inbox" />
      <AccountsClient
        initial={accounts.map((a) => ({ ...a, lastSyncedAt: a.lastSyncedAt ? a.lastSyncedAt.toISOString() : null }))}
      />
    </div>
  );
}
