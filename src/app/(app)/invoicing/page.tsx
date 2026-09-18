import Link from 'next/link';
import { prisma } from '@/lib/prisma';
import { requireModule } from '@/lib/session';
import PageHeader from '@/components/PageHeader';
import Badge from '@/components/Badge';
import { money, formatDate } from '@/lib/format';
import { Plus, Download } from 'lucide-react';

export default async function InvoicingPage({ searchParams }: { searchParams: { status?: string } }) {
  await requireModule('invoicing');
  const status = searchParams.status;
  const invoices = await prisma.invoice.findMany({
    where: status ? { status: status as never } : undefined,
    include: { company: true },
    orderBy: { createdAt: 'desc' },
  });

  return (
    <div>
      <PageHeader
        title="Invoicing"
        subtitle={`${invoices.length} documents`}
        actions={
          <>
            <a href={`/api/invoices?format=csv${status ? `&status=${status}` : ''}`} className="btn-secondary"><Download size={16} /> Export CSV</a>
            <Link href="/invoicing/new" className="btn-primary"><Plus size={16} /> New Invoice</Link>
          </>
        }
      />

      <form className="card p-4 mb-4 flex gap-3" method="get">
        <select name="status" defaultValue={status} className="input max-w-[200px]">
          <option value="">All statuses</option>
          <option value="DRAFT">Draft</option>
          <option value="SENT">Sent</option>
          <option value="PARTIAL">Partial</option>
          <option value="PAID">Paid</option>
          <option value="OVERDUE">Overdue</option>
          <option value="CANCELLED">Cancelled</option>
        </select>
        <button type="submit" className="btn-secondary">Filter</button>
      </form>

      <div className="card overflow-x-auto">
        <table className="table-base">
          <thead><tr><th>Number</th><th>Type</th><th>Company</th><th>Status</th><th>Total</th><th>Balance</th><th>Due date</th></tr></thead>
          <tbody>
            {invoices.map((i) => (
              <tr key={i.id} className="hover:bg-slate-50">
                <td><Link href={`/invoicing/${i.id}`} className="font-medium text-brand-700 hover:underline">{i.number}</Link></td>
                <td>{i.type}</td>
                <td>{i.company?.name || '—'}</td>
                <td><Badge label={i.status} /></td>
                <td>{money(i.total)}</td>
                <td>{money(Number(i.total) - Number(i.amountPaid))}</td>
                <td>{formatDate(i.dueDate)}</td>
              </tr>
            ))}
            {invoices.length === 0 && <tr><td colSpan={7} className="text-center text-slate-500 py-8">No invoices yet.</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}
