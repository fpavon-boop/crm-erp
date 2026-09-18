import Link from 'next/link';
import { notFound } from 'next/navigation';
import { prisma } from '@/lib/prisma';
import { requireModule } from '@/lib/session';
import PageHeader from '@/components/PageHeader';
import Badge from '@/components/Badge';
import { money, formatDate } from '@/lib/format';
import { StatusControls, CreateInvoiceButton } from './OrderActions';
import { Pencil } from 'lucide-react';

export default async function OrderDetailPage({ params }: { params: { id: string } }) {
  await requireModule('sales');
  const order = await prisma.salesOrder.findUnique({
    where: { id: params.id },
    include: { company: true, contact: true, items: true, invoices: true, quote: true },
  });
  if (!order) notFound();

  return (
    <div>
      <PageHeader
        title={order.number}
        subtitle={order.company?.name}
        actions={
          <>
            <Link href={`/sales/orders/${order.id}/edit`} className="btn-secondary"><Pencil size={16} /> Edit</Link>
            <StatusControls orderId={order.id} status={order.status} />
            {order.invoices.length === 0 && <CreateInvoiceButton orderId={order.id} />}
          </>
        }
      />

      <div className="card p-6 mb-6">
        <p className="mb-4"><Badge label={order.status} /></p>
        <table className="table-base">
          <thead><tr><th>Description</th><th>Qty</th><th>Unit price</th><th>Tax</th></tr></thead>
          <tbody>
            {order.items.map((i) => (
              <tr key={i.id}>
                <td>{i.description}</td>
                <td>{i.quantity.toString()}</td>
                <td>{money(i.unitPrice)}</td>
                <td>{i.taxRate.toString()}%</td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="mt-4 flex justify-end">
          <table className="text-sm w-64">
            <tbody>
              <tr className="font-semibold border-t border-slate-200"><td className="py-1">Total</td><td className="text-right">{money(order.total)}</td></tr>
            </tbody>
          </table>
        </div>
      </div>

      {order.invoices.length > 0 && (
        <div className="card p-5">
          <h2 className="font-semibold text-slate-800 mb-2">Invoices</h2>
          <ul className="text-sm space-y-1">
            {order.invoices.map((inv) => (
              <li key={inv.id} className="flex justify-between">
                <Link href={`/invoicing/${inv.id}`} className="text-brand-700 hover:underline">{inv.number}</Link>
                <span>{money(inv.total)} · {formatDate(inv.issueDate)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
