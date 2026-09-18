import Link from 'next/link';
import { prisma } from '@/lib/prisma';
import { requireModule } from '@/lib/session';
import PageHeader from '@/components/PageHeader';
import Badge from '@/components/Badge';
import { money, formatDate } from '@/lib/format';
import { Plus, Download } from 'lucide-react';

export default async function SalesOrdersPage() {
  await requireModule('sales');
  const orders = await prisma.salesOrder.findMany({ include: { company: true }, orderBy: { createdAt: 'desc' } });

  return (
    <div>
      <PageHeader
        title="Sales Orders"
        subtitle={`${orders.length} orders`}
        actions={
          <>
            <a href="/api/sales-orders?format=csv" className="btn-secondary"><Download size={16} /> Export CSV</a>
            <Link href="/sales/orders/new" className="btn-primary"><Plus size={16} /> New Order</Link>
          </>
        }
      />
      <div className="card overflow-x-auto">
        <table className="table-base">
          <thead><tr><th>Number</th><th>Company</th><th>Status</th><th>Total</th><th>Created</th></tr></thead>
          <tbody>
            {orders.map((o) => (
              <tr key={o.id} className="hover:bg-slate-50">
                <td><Link href={`/sales/orders/${o.id}`} className="font-medium text-brand-700 hover:underline">{o.number}</Link></td>
                <td>{o.company?.name || '—'}</td>
                <td><Badge label={o.status} /></td>
                <td>{money(o.total)}</td>
                <td>{formatDate(o.createdAt)}</td>
              </tr>
            ))}
            {orders.length === 0 && <tr><td colSpan={5} className="text-center text-slate-500 py-8">No orders yet.</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}
