import { prisma } from '@/lib/prisma';
import { requireModule } from '@/lib/session';
import PageHeader from '@/components/PageHeader';
import WhatsAppSettingsClient from './WhatsAppSettingsClient';

export default async function WhatsAppSettingsPage() {
  await requireModule('whatsapp');
  const [accounts, templates] = await Promise.all([
    prisma.whatsAppAccount.findMany({
      select: { id: true, label: true, phoneNumberId: true, businessAccountId: true, displayPhoneNumber: true, active: true },
      orderBy: { createdAt: 'desc' },
    }),
    prisma.whatsAppTemplate.findMany(),
  ]);

  return (
    <div>
      <PageHeader title="WhatsApp Settings" />
      <WhatsAppSettingsClient accounts={accounts} templates={templates} />
    </div>
  );
}
