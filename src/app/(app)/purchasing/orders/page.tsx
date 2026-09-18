import Link from 'next/link';
import { prisma } from '@/lib/prisma';
import { requireModule } from '@/lib/session';
import PageHeader from '@/components/PageHeader';
import Badge from '@/components/Badge';
import { money, formatDate } from '@/lib/format';
import { Plus } from 'lucide-react';

export default async function PurchaseOrdersPage() {
  await requireModule('purchasing');
  const orders = await prisma.purchaseOrder.findMany({ include: { supplier: true }, orderBy: { createdAt: 'desc' } });

  return (
    <div>
      <PageHeader
        title="Purchase Orders"
        subtitle={`${orders.length} orders`}
        actions={<Link href="/purchasing/orders/new" className="btn-primary"><Plus size={16} /> New Purchase Order</Link>}
      />
      <div className="card overflow-x-auto">
        <table className="table-base">
          <thead><tr><th>Number</th><th>Supplier</th><th>Status</th><th>Total</th><th>Expected</th></tr></thead>
          <tbody>
            {orders.map((o) => (
              <tr key={o.id} className="hover:bg-slate-50">
                <td><Link href={`/purchasing/orders/${o.id}`} className="font-medium text-brand-700 hover:underline">{o.number}</Link></td>
                <td>{o.supplier?.name || '—'}</td>
                <td><Badge label={o.status} /></td>
                <td>{money(o.total)}</td>
                <td>{formatDate(o.expectedDate)}</td>
              </tr>
            ))}
            {orders.length === 0 && <tr><td colSpan={5} className="text-center text-slate-500 py-8">No purchase orders yet.</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}
