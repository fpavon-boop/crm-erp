import Link from 'next/link';
import { notFound } from 'next/navigation';
import { prisma } from '@/lib/prisma';
import { requireModule } from '@/lib/session';
import PageHeader from '@/components/PageHeader';
import Badge from '@/components/Badge';
import { money, formatDate } from '@/lib/format';
import ConvertButton from './ConvertButton';
import { Pencil } from 'lucide-react';

export default async function QuoteDetailPage({ params }: { params: { id: string } }) {
  await requireModule('sales');
  const quote = await prisma.quote.findUnique({
    where: { id: params.id },
    include: { company: true, contact: true, items: true, salesOrders: true },
  });
  if (!quote) notFound();

  return (
    <div>
      <PageHeader
        title={quote.number}
        subtitle={quote.company?.name}
        actions={
          <>
            <Link href={`/sales/quotes/${quote.id}/edit`} className="btn-secondary"><Pencil size={16} /> Edit</Link>
            {quote.status === 'ACCEPTED' && quote.salesOrders.length === 0 && <ConvertButton quoteId={quote.id} />}
          </>
        }
      />

      <div className="card p-6 mb-6">
        <div className="flex justify-between mb-4">
          <div className="text-sm space-y-1">
            <p><Badge label={quote.status} /></p>
            <p className="text-slate-500">Valid until {formatDate(quote.validUntil)}</p>
            {quote.contact && <p>Contact: {quote.contact.firstName} {quote.contact.lastName}</p>}
          </div>
        </div>
        <table className="table-base">
          <thead><tr><th>Description</th><th>Qty</th><th>Unit price</th><th>Tax</th><th>Discount</th></tr></thead>
          <tbody>
            {quote.items.map((i) => (
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
              <tr><td className="py-1 text-slate-500">Subtotal</td><td className="text-right">{money(quote.subtotal)}</td></tr>
              <tr><td className="py-1 text-slate-500">Tax</td><td className="text-right">{money(quote.taxTotal)}</td></tr>
              <tr><td className="py-1 text-slate-500">Discount</td><td className="text-right">-{money(quote.discountTotal)}</td></tr>
              <tr className="font-semibold border-t border-slate-200"><td className="py-1">Total</td><td className="text-right">{money(quote.total)}</td></tr>
            </tbody>
          </table>
        </div>
        {quote.notes && <p className="text-sm text-slate-500 mt-4">{quote.notes}</p>}
      </div>

      {quote.salesOrders.length > 0 && (
        <div className="card p-5">
          <h2 className="font-semibold text-slate-800 mb-2">Related sales orders</h2>
          <ul className="text-sm space-y-1">
            {quote.salesOrders.map((o) => (
              <li key={o.id}><Link href={`/sales/orders/${o.id}`} className="text-brand-700 hover:underline">{o.number}</Link></li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
