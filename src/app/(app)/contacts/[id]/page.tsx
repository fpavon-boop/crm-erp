import Link from 'next/link';
import { notFound } from 'next/navigation';
import { prisma } from '@/lib/prisma';
import { requireModule } from '@/lib/session';
import PageHeader from '@/components/PageHeader';
import Badge from '@/components/Badge';
import { money, formatDate, formatDateTime } from '@/lib/format';
import { Pencil } from 'lucide-react';

export default async function ContactDetailPage({ params }: { params: { id: string } }) {
  await requireModule('contacts');

  const contact = await prisma.contact.findUnique({
    where: { id: params.id },
    include: {
      company: true,
      opportunities: true,
      quotes: { orderBy: { createdAt: 'desc' } },
      salesOrders: { orderBy: { createdAt: 'desc' } },
      invoices: { orderBy: { createdAt: 'desc' } },
      notesList: { orderBy: { createdAt: 'desc' }, include: { author: true } },
      communicationLogs: { orderBy: { occurredAt: 'desc' } },
      emailMessages: { orderBy: { receivedAt: 'desc' }, take: 10 },
      whatsappMessages: { orderBy: { timestamp: 'desc' }, take: 10 },
    },
  });
  if (!contact) notFound();

  return (
    <div>
      <PageHeader
        title={`${contact.firstName} ${contact.lastName}`}
        subtitle={contact.position || undefined}
        actions={
          <Link href={`/contacts/${contact.id}/edit`} className="btn-secondary">
            <Pencil size={16} /> Edit
          </Link>
        }
      />

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="space-y-6">
          <div className="card p-5 text-sm space-y-2">
            <Row label="Company">
              {contact.company ? (
                <Link href={`/companies/${contact.company.id}`} className="text-brand-700 hover:underline">
                  {contact.company.name}
                </Link>
              ) : '—'}
            </Row>
            <Row label="Email">{contact.email || '—'}</Row>
            <Row label="Phone">{contact.phone || '—'}</Row>
            <Row label="Mobile">{contact.mobile || '—'}</Row>
          </div>

          <div className="card p-5">
            <h2 className="font-semibold text-slate-800 mb-2">Notes</h2>
            <ul className="text-sm space-y-2">
              {contact.notesList.map((n) => (
                <li key={n.id} className="border-b border-slate-100 pb-2">
                  <p>{n.body}</p>
                  <p className="text-xs text-slate-400">{n.author.name} · {formatDateTime(n.createdAt)}</p>
                </li>
              ))}
              {contact.notesList.length === 0 && <p className="text-slate-400">No notes yet.</p>}
            </ul>
          </div>
        </div>

        <div className="lg:col-span-2 space-y-6">
          <div className="card p-5">
            <h2 className="font-semibold text-slate-800 mb-3">Communication history</h2>
            <ul className="text-sm space-y-2 max-h-72 overflow-y-auto">
              {contact.communicationLogs.map((log) => (
                <li key={log.id} className="border-b border-slate-100 pb-2">
                  <div className="flex items-center gap-2">
                    <Badge label={log.type} />
                    <span className="text-xs text-slate-400">{log.direction} · {formatDateTime(log.occurredAt)}</span>
                  </div>
                  {log.body && <p className="text-slate-600">{log.body}</p>}
                </li>
              ))}
              {contact.communicationLogs.length === 0 && <p className="text-slate-400">No communication history yet.</p>}
            </ul>
          </div>

          <div className="card p-5">
            <h2 className="font-semibold text-slate-800 mb-3">Invoices</h2>
            <ul className="text-sm divide-y divide-slate-100">
              {contact.invoices.map((i) => (
                <li key={i.id} className="py-2 flex justify-between">
                  <Link href={`/invoicing/${i.id}`} className="text-brand-700 hover:underline">{i.number}</Link>
                  <div className="flex gap-2 items-center"><Badge label={i.status} /> {money(i.total)}</div>
                </li>
              ))}
              {contact.invoices.length === 0 && <p className="text-slate-400">No invoices yet.</p>}
            </ul>
          </div>
        </div>
      </div>
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex justify-between gap-4">
      <dt className="text-slate-500">{label}</dt>
      <dd className="text-slate-800 text-right">{children}</dd>
    </div>
  );
}
