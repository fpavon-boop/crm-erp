import Link from 'next/link';
import { prisma } from '@/lib/prisma';
import { requireModule } from '@/lib/session';
import PageHeader from '@/components/PageHeader';
import Badge from '@/components/Badge';
import { money, formatDate } from '@/lib/format';
import { Plus } from 'lucide-react';

export default async function PurchasingPage() {
  await requireModule('purchasing');
  const [orders, invoices] = await Promise.all([
    prisma.purchaseOrder.findMany({ include: { supplier: true }, orderBy: { createdAt: 'desc' }, take: 10 }),
    prisma.supplierInvoice.findMany({ include: { supplier: true }, orderBy: { createdAt: 'desc' }, take: 10 }),
  ]);

  return (
    <div>
      <PageHeader
        title="Purchasing"
        actions={
          <>
            <Link href="/purchasing/supplier-invoices/new" className="btn-secondary">New Supplier Invoice</Link>
            <Link href="/purchasing/orders/new" className="btn-primary"><Plus size={16} /> New Purchase Order</Link>
          </>
        }
      />

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="card p-5">
          <div className="flex justify-between items-center mb-3">
            <h2 className="font-semibold text-slate-800">Recent purchase orders</h2>
            <Link href="/purchasing/orders" className="text-sm text-brand-700 hover:underline">View all</Link>
          </div>
          <table className="table-base">
            <thead><tr><th>Number</th><th>Supplier</th><th>Status</th><th>Total</th></tr></thead>
            <tbody>
              {orders.map((o) => (
                <tr key={o.id}>
                  <td><Link href={`/purchasing/orders/${o.id}`} className="text-brand-700 hover:underline">{o.number}</Link></td>
                  <td>{o.supplier?.name || '—'}</td>
                  <td><Badge label={o.status} /></td>
                  <td>{money(o.total)}</td>
                </tr>
              ))}
              {orders.length === 0 && <tr><td colSpan={4} className="text-center text-slate-500 py-6">No purchase orders yet.</td></tr>}
            </tbody>
          </table>
        </div>

        <div className="card p-5">
          <div className="flex justify-between items-center mb-3">
            <h2 className="font-semibold text-slate-800">Recent supplier invoices</h2>
            <Link href="/purchasing/supplier-invoices" className="text-sm text-brand-700 hover:underline">View all</Link>
          </div>
          <table className="table-base">
            <thead><tr><th>Number</th><th>Supplier</th><th>Status</th><th>Amount</th><th>Due</th></tr></thead>
            <tbody>
              {invoices.map((i) => (
                <tr key={i.id}>
                  <td>{i.number}</td>
                  <td>{i.supplier?.name || '—'}</td>
                  <td><Badge label={i.status} /></td>
                  <td>{money(i.amount)}</td>
                  <td>{formatDate(i.dueDate)}</td>
                </tr>
              ))}
              {invoices.length === 0 && <tr><td colSpan={5} className="text-center text-slate-500 py-6">No supplier invoices yet.</td></tr>}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
