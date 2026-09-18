import Link from 'next/link';
import { prisma } from '@/lib/prisma';
import { requireModule } from '@/lib/session';
import PageHeader from '@/components/PageHeader';
import Badge from '@/components/Badge';
import { money, formatDate } from '@/lib/format';
import { Plus } from 'lucide-react';

export default async function QuotesPage() {
  await requireModule('sales');
  const quotes = await prisma.quote.findMany({ include: { company: true }, orderBy: { createdAt: 'desc' } });

  return (
    <div>
      <PageHeader
        title="Quotes"
        subtitle={`${quotes.length} quotes`}
        actions={<Link href="/sales/quotes/new" className="btn-primary"><Plus size={16} /> New Quote</Link>}
      />
      <div className="card overflow-x-auto">
        <table className="table-base">
          <thead><tr><th>Number</th><th>Company</th><th>Status</th><th>Total</th><th>Valid until</th><th>Created</th></tr></thead>
          <tbody>
            {quotes.map((q) => (
              <tr key={q.id} className="hover:bg-slate-50">
                <td><Link href={`/sales/quotes/${q.id}`} className="font-medium text-brand-700 hover:underline">{q.number}</Link></td>
                <td>{q.company?.name || '—'}</td>
                <td><Badge label={q.status} /></td>
                <td>{money(q.total)}</td>
                <td>{formatDate(q.validUntil)}</td>
                <td>{formatDate(q.createdAt)}</td>
              </tr>
            ))}
            {quotes.length === 0 && <tr><td colSpan={6} className="text-center text-slate-500 py-8">No quotes yet.</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}
