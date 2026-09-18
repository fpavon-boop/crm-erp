import Link from 'next/link';
import { prisma } from '@/lib/prisma';
import { requireModule } from '@/lib/session';
import PageHeader from '@/components/PageHeader';
import { Settings } from 'lucide-react';
import WhatsAppClient from './WhatsAppClient';

export default async function WhatsAppPage() {
  await requireModule('whatsapp');
  const [messages, templates] = await Promise.all([
    prisma.whatsAppMessage.findMany({
      include: { contact: true, company: true },
      orderBy: { timestamp: 'asc' },
      take: 300,
    }),
    prisma.whatsAppTemplate.findMany(),
  ]);

  const byNumber = new Map<string, typeof messages>();
  for (const m of messages) {
    const key = m.direction === 'INBOUND' ? m.fromNumber : m.toNumber;
    if (!byNumber.has(key)) byNumber.set(key, []);
    byNumber.get(key)!.push(m);
  }

  const conversations = Array.from(byNumber.entries())
    .map(([number, msgs]) => ({
      key: number,
      number,
      contact: msgs[0]?.contact ? { id: msgs[0].contact.id, firstName: msgs[0].contact.firstName, lastName: msgs[0].contact.lastName } : null,
      company: msgs[0]?.company ? { id: msgs[0].company.id, name: msgs[0].company.name } : null,
      messages: msgs.map((m) => ({
        id: m.id,
        direction: m.direction,
        fromNumber: m.fromNumber,
        toNumber: m.toNumber,
        body: m.body,
        templateName: m.templateName,
        status: m.status,
        timestamp: m.timestamp.toISOString(),
        contact: m.contact,
        company: m.company,
      })),
    }))
    .sort((a, b) => +new Date(b.messages.at(-1)?.timestamp || 0) - +new Date(a.messages.at(-1)?.timestamp || 0));

  return (
    <div>
      <PageHeader
        title="WhatsApp"
        subtitle="Official WhatsApp Business (Meta Cloud API) conversations"
        actions={<Link href="/whatsapp/settings" className="btn-secondary"><Settings size={16} /> Settings</Link>}
      />
      <WhatsAppClient conversations={conversations} templates={templates.map((t) => ({ id: t.id, name: t.name, language: t.language }))} />
    </div>
  );
}
