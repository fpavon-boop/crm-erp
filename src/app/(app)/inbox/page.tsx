import Link from 'next/link';
import { prisma } from '@/lib/prisma';
import { requireModule } from '@/lib/session';
import PageHeader from '@/components/PageHeader';
import InboxClient from './InboxClient';
import { Settings } from 'lucide-react';

export default async function InboxPage() {
  await requireModule('inbox');
  const messages = await prisma.emailMessage.findMany({
    include: { company: true, contact: true },
    orderBy: { receivedAt: 'desc' },
    take: 100,
  });

  return (
    <div>
      <PageHeader
        title="Email Inbox"
        subtitle="Connected mailboxes, auto-linked to companies & contacts"
        actions={<Link href="/inbox/accounts" className="btn-secondary"><Settings size={16} /> Manage Accounts</Link>}
      />
      <InboxClient
        initial={messages.map((m) => ({
          id: m.id,
          direction: m.direction,
          fromAddress: m.fromAddress,
          toAddresses: m.toAddresses,
          subject: m.subject,
          bodyText: m.bodyText,
          receivedAt: m.receivedAt.toISOString(),
          isRead: m.isRead,
          isAnswered: m.isAnswered,
          company: m.company ? { id: m.company.id, name: m.company.name } : null,
          contact: m.contact,
        }))}
      />
    </div>
  );
}
