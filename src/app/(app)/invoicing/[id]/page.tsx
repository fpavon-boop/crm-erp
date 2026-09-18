import Link from 'next/link';
import { notFound } from 'next/navigation';
import { prisma } from '@/lib/prisma';
import { requireModule } from '@/lib/session';
import PageHeader from '@/components/PageHeader';
import Badge from '@/components/Badge';
import { money, formatDate, formatDateTime } from '@/lib/format';
import { SendInvoiceButton, RecordPaymentForm } from './InvoiceActions';
import { Pencil, Download } from 'lucide-react';

export default async function InvoiceDetailPage({ params }: { params: { id: string } }) {
  await requireModule('invoicing');
  const invoice = await prisma.invoice.findUnique({
    where: { id: params.id },
    include: { company: true, contact: true, items: true, payments: { orderBy: { paidAt: 'desc' } }, salesOrder: true },
  });
  if (!invoice) notFound();

  const balance = Number(invoice.total) - Number(invoice.amountPaid);

  return (
    <div>
      <PageHeader
        title={invoice.number}
        subtitle={`${invoice.type} · ${invoice.company?.name || 'No company'}`}
        actions={
          <>
            <a href={`/api/invoices/${invoice.id}/pdf`} className="btn-secondary"><Download size={16} /> Download PDF</a>
            <SendInvoiceButton invoiceId={invoice.id} />
            <Link href={`/invoicing/${invoice.id}/edit`} className="btn-secondary"><Pencil size={16} /> Edit</Link>
          </>
        }
      />

      <div className="card p-6 mb-6">
        <div className="flex justify-between mb-4 text-sm">
          <div className="space-y-1">
            <p><Badge label={invoice.status} /></p>
            <p className="text-slate-500">Issued {formatDate(invoice.issueDate)} · Due {formatDate(invoice.dueDate)}</p>
            {invoice.contact && <p>Contact: {invoice.contact.firstName} {invoice.contact.lastName}</p>}
            {invoice.salesOrder && <p>Order: <Link href={`/sales/orders/${invoice.salesOrder.id}`} className="text-brand-700 hover:underline">{invoice.salesOrder.number}</Link></p>}
          </div>
        </div>
        <table className="table-base">
          <thead><tr><th>Description</th><th>Qty</th><th>Unit price</th><th>Tax</th><th>Discount</th></tr></thead>
          <tbody>
            {invoice.items.map((i) => (
              <tr key={i.id}>
                <td>{i.description}</td>
                <td>{i.quantity.toString()}</td>
                <td>{money(i.unitPrice)}</td>
                <td>{i.taxRate.toString()}%</td>
                <td>{money(i.discount)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="mt-4 flex justify-end">
          <table className="text-sm w-64">
            <tbody>
              <tr><td className="py-1 text-slate-500">Subtotal</td><td className="text-right">{money(invoice.subtotal)}</td></tr>
              <tr><td className="py-1 text-slate-500">Tax</td><td className="text-right">{money(invoice.taxTotal)}</td></tr>
              <tr><td className="py-1 text-slate-500">Discount</td><td className="text-right">-{money(invoice.discountTotal)}</td></tr>
              <tr className="font-semibold border-t border-slate-200"><td className="py-1">Total</td><td className="text-right">{money(invoice.total)}</td></tr>
              <tr><td className="py-1 text-slate-500">Paid</td><td className="text-right">{money(invoice.amountPaid)}</td></tr>
              <tr className="font-semibold"><td className="py-1">Balance</td><td className="text-right">{money(balance)}</td></tr>
            </tbody>
          </table>
        </div>
      </div>

      <div className="card p-5">
        <h2 className="font-semibold text-slate-800 mb-3">Payments</h2>
        <RecordPaymentForm invoiceId={invoice.id} balance={balance} />
        <ul className="text-sm divide-y divide-slate-100 mt-4">
          {invoice.payments.map((p) => (
            <li key={p.id} className="py-2 flex justify-between">
              <span>{p.method} {p.reference && `(${p.reference})`}</span>
              <span>{money(p.amount)} · {formatDateTime(p.paidAt)}</span>
            </li>
          ))}
          {invoice.payments.length === 0 && <p className="text-slate-400 mt-2">No payments recorded yet.</p>}
        </ul>
      </div>
    </div>
  );
}
