import Link from 'next/link';
import { notFound } from 'next/navigation';
import { prisma } from '@/lib/prisma';
import { requireModule } from '@/lib/session';
import PageHeader from '@/components/PageHeader';
import Badge from '@/components/Badge';
import { money, formatDate, formatDateTime } from '@/lib/format';
import { AddNoteForm, UploadDocumentForm, DeleteCompanyButton } from './CompanyDetailClient';
import { Pencil, Download } from 'lucide-react';

export default async function CompanyDetailPage({ params }: { params: { id: string } }) {
  await requireModule('companies');

  const company = await prisma.company.findUnique({
    where: { id: params.id },
    include: {
      phones: true,
      emails: true,
      contacts: true,
      owner: true,
      invoices: { orderBy: { createdAt: 'desc' }, take: 20 },
      salesOrders: { orderBy: { createdAt: 'desc' }, take: 20 },
      quotes: { orderBy: { createdAt: 'desc' }, take: 20 },
      purchaseOrders: { orderBy: { createdAt: 'desc' }, take: 20 },
      documents: { orderBy: { createdAt: 'desc' } },
      notesList: { orderBy: { createdAt: 'desc' }, include: { author: true } },
      communicationLogs: { orderBy: { occurredAt: 'desc' }, take: 30 },
      emailMessages: { orderBy: { receivedAt: 'desc' }, take: 10 },
      whatsappMessages: { orderBy: { timestamp: 'desc' }, take: 10 },
    },
  });
  if (!company) notFound();

  const unpaidInvoices = await prisma.invoice.findMany({
    where: { companyId: company.id, status: { in: ['SENT', 'PARTIAL', 'OVERDUE'] } },
    select: { total: true, amountPaid: true },
  });
  const accountBalance = unpaidInvoices.reduce(
    (sum, inv) => sum + (Number(inv.total) - Number(inv.amountPaid)),
    0
  );

  return (
    <div>
      <PageHeader
        title={company.name}
        subtitle={`${company.type} · ${company.contacts.length} contacts`}
        actions={
          <>
            <Link href={`/companies/${company.id}/edit`} className="btn-secondary">
              <Pencil size={16} /> Edit
            </Link>
            <DeleteCompanyButton companyId={company.id} />
          </>
        }
      />

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-1 space-y-6">
          <div className="card p-5">
            <h2 className="font-semibold text-slate-800 mb-3">Profile</h2>
            <dl className="text-sm space-y-2">
              <Row label="Type"><Badge label={company.type} /></Row>
              <Row label="Tax ID">{company.taxId || '—'}</Row>
              <Row label="Industry">{company.industry || '—'}</Row>
              <Row label="Website">{company.website || '—'}</Row>
              <Row label="Owner">{company.owner?.name || 'Unassigned'}</Row>
            </dl>
          </div>

          <div className="card p-5">
            <h2 className="font-semibold text-slate-800 mb-3">Address</h2>
            <p className="text-sm text-slate-600">
              {company.addressLine1 || '—'}
              {company.addressLine2 ? <><br />{company.addressLine2}</> : null}
              <br />
              {[company.city, company.state, company.postalCode].filter(Boolean).join(', ')}
              <br />
              {company.country}
            </p>
          </div>

          <div className="card p-5">
            <h2 className="font-semibold text-slate-800 mb-3">Contact details</h2>
            <div className="text-sm space-y-1">
              {company.phones.map((p) => (
                <div key={p.id}>📞 {p.number} <span className="text-slate-400">({p.label})</span></div>
              ))}
              {company.emails.map((e) => (
                <div key={e.id}>✉️ {e.address} <span className="text-slate-400">({e.label})</span></div>
              ))}
              {company.phones.length === 0 && company.emails.length === 0 && (
                <p className="text-slate-400">No contact details on file.</p>
              )}
            </div>
          </div>

          <div className="card p-5">
            <h2 className="font-semibold text-slate-800 mb-1">Account balance</h2>
            <p className={`text-2xl font-bold ${accountBalance > 0 ? 'text-red-600' : 'text-green-600'}`}>
              {money(accountBalance)}
            </p>
            <p className="text-xs text-slate-500 mt-1">Sum of unpaid & overdue invoices</p>
          </div>

          <div className="card p-5">
            <h2 className="font-semibold text-slate-800 mb-3">Contacts ({company.contacts.length})</h2>
            <ul className="text-sm space-y-1">
              {company.contacts.map((c) => (
                <li key={c.id}>
                  <Link className="text-brand-700 hover:underline" href={`/contacts/${c.id}`}>
                    {c.firstName} {c.lastName}
                  </Link>
                  {c.position && <span className="text-slate-400"> — {c.position}</span>}
                </li>
              ))}
              {company.contacts.length === 0 && <p className="text-slate-400">No contacts yet.</p>}
            </ul>
          </div>
        </div>

        <div className="lg:col-span-2 space-y-6">
          <div className="card p-5">
            <h2 className="font-semibold text-slate-800 mb-3">Notes</h2>
            <AddNoteForm companyId={company.id} />
            <ul className="text-sm space-y-3 max-h-64 overflow-y-auto">
              {company.notesList.map((n) => (
                <li key={n.id} className="border-b border-slate-100 pb-2">
                  <p>{n.body}</p>
                  <p className="text-xs text-slate-400">{n.author.name} · {formatDateTime(n.createdAt)}</p>
                </li>
              ))}
              {company.notesList.length === 0 && <p className="text-slate-400">No notes yet.</p>}
            </ul>
          </div>

          <div className="card p-5">
            <h2 className="font-semibold text-slate-800 mb-3">Documents</h2>
            <UploadDocumentForm companyId={company.id} />
            <ul className="text-sm divide-y divide-slate-100">
              {company.documents.map((d) => (
                <li key={d.id} className="py-2 flex items-center justify-between">
                  <span>{d.filename}</span>
                  <a href={`/api/documents/${d.id}/download`} className="text-brand-700 hover:underline flex items-center gap-1">
                    <Download size={14} /> Download
                  </a>
                </li>
              ))}
              {company.documents.length === 0 && <p className="text-slate-400">No documents uploaded.</p>}
            </ul>
          </div>

          <div className="card p-5">
            <h2 className="font-semibold text-slate-800 mb-3">Communication history</h2>
            <ul className="text-sm space-y-2 max-h-72 overflow-y-auto">
              {company.communicationLogs.map((log) => (
                <li key={log.id} className="border-b border-slate-100 pb-2">
                  <div className="flex items-center gap-2">
                    <Badge label={log.type} />
                    <span className="text-xs text-slate-400">{log.direction} · {formatDateTime(log.occurredAt)}</span>
                  </div>
                  {log.subject && <p className="font-medium">{log.subject}</p>}
                  {log.body && <p className="text-slate-600 line-clamp-2">{log.body}</p>}
                </li>
              ))}
              {company.communicationLogs.length === 0 && <p className="text-slate-400">No communication history yet.</p>}
            </ul>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <div className="card p-5">
              <h2 className="font-semibold text-slate-800 mb-3">Invoices</h2>
              <RecordList
                items={company.invoices.map((i) => ({
                  id: i.id,
                  href: `/invoicing/${i.id}`,
                  label: i.number,
                  status: i.status,
                  amount: money(i.total),
                  date: formatDate(i.issueDate),
                }))}
                emptyLabel="No invoices yet."
              />
            </div>
            <div className="card p-5">
              <h2 className="font-semibold text-slate-800 mb-3">Sales orders</h2>
              <RecordList
                items={company.salesOrders.map((o) => ({
                  id: o.id,
                  href: `/sales/orders/${o.id}`,
                  label: o.number,
                  status: o.status,
                  amount: money(o.total),
                  date: formatDate(o.createdAt),
                }))}
                emptyLabel="No orders yet."
              />
            </div>
            <div className="card p-5">
              <h2 className="font-semibold text-slate-800 mb-3">Quotes</h2>
              <RecordList
                items={company.quotes.map((q) => ({
                  id: q.id,
                  href: `/sales/quotes/${q.id}`,
                  label: q.number,
                  status: q.status,
                  amount: money(q.total),
                  date: formatDate(q.createdAt),
                }))}
                emptyLabel="No quotes yet."
              />
            </div>
            <div className="card p-5">
              <h2 className="font-semibold text-slate-800 mb-3">Purchase orders</h2>
              <RecordList
                items={company.purchaseOrders.map((p) => ({
                  id: p.id,
                  href: `/purchasing/orders/${p.id}`,
                  label: p.number,
                  status: p.status,
                  amount: money(p.total),
                  date: formatDate(p.createdAt),
                }))}
                emptyLabel="No purchase orders yet."
              />
            </div>
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

function RecordList({
  items,
  emptyLabel,
}: {
  items: { id: string; href: string; label: string; status: string; amount: string; date: string }[];
  emptyLabel: string;
}) {
  if (items.length === 0) return <p className="text-slate-400 text-sm">{emptyLabel}</p>;
  return (
    <ul className="text-sm divide-y divide-slate-100">
      {items.map((item) => (
        <li key={item.id} className="py-2 flex items-center justify-between">
          <Link href={item.href} className="text-brand-700 hover:underline">
            {item.label}
          </Link>
          <div className="flex items-center gap-2">
            <Badge label={item.status} />
            <span className="text-slate-600">{item.amount}</span>
          </div>
        </li>
      ))}
    </ul>
  );
}
