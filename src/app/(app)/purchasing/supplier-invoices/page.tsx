import Link from 'next/link';
import { prisma } from '@/lib/prisma';
import { requireModule } from '@/lib/session';
import PageHeader from '@/components/PageHeader';
import Badge from '@/components/Badge';
import { money, formatDate } from '@/lib/format';
import { Plus } from 'lucide-react';

export default async function SupplierInvoicesPage() {
  await requireModule('purchasing');
  const invoices = await prisma.supplierInvoice.findMany({ include: { supplier: true, purchaseOrder: true }, orderBy: { createdAt: 'desc' } });

  return (
    <div>
      <PageHeader
        title="Supplier Invoices"
        subtitle={`${invoices.length} invoices`}
        actions={<Link href="/purchasing/supplier-invoices/new" className="btn-primary"><Plus size={16} /> New Supplier Invoice</Link>}
      />
      <div className="card overflow-x-auto">
        <table className="table-base">
          <thead><tr><th>Number</th><th>Supplier</th><th>PO</th><th>Status</th><th>Amount</th><th>Due</th></tr></thead>
          <tbody>
            {invoices.map((i) => (
              <tr key={i.id}>
                <td className="font-medium">{i.number}</td>
                <td>{i.supplier?.name || '—'}</td>
                <td>{i.purchaseOrder?.number || '—'}</td>
                <td><Badge label={i.status} /></td>
                <td>{money(i.amount)}</td>
                <td>{formatDate(i.dueDate)}</td>
              </tr>
            ))}
            {invoices.length === 0 && <tr><td colSpan={6} className="text-center text-slate-500 py-8">No supplier invoices yet.</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}
