import Link from 'next/link';
import { requireModule } from '@/lib/session';
import PageHeader from '@/components/PageHeader';
import { getAccountsReceivableDashboard, type ARAgingBuckets } from '@/lib/accounts-receivable';
import { money } from '@/lib/format';

export const dynamic = 'force-dynamic';

function Stat({ label, value, sub, color }: { label: string; value: string; sub?: string; color?: string }) {
  return (
    <div className="card p-4">
      <p className="text-xs uppercase tracking-wide text-slate-500">{label}</p>
      <p className={`text-2xl font-bold mt-1 ${color || 'text-slate-900'}`}>{value}</p>
      {sub && <p className="text-xs text-slate-400 mt-1">{sub}</p>}
    </div>
  );
}

function AgingCard({ data }: { data: ARAgingBuckets }) {
  const rows: Array<[string, number]> = [
    ['0–30 days late', data.d0to30],
    ['31–60 days late', data.d31to60],
    ['61–90 days late', data.d61to90],
    ['90+ days late', data.d90plus],
  ];
  return (
    <div className="card p-5">
      <div className="flex items-baseline justify-between mb-3">
        <h2 className="font-semibold text-slate-800">Aging (past due balances)</h2>
        <span className="text-xs text-slate-500">{data.count} overdue</span>
      </div>
      {data.count === 0 ? (
        <p className="text-sm text-slate-400">No overdue invoices.</p>
      ) : (
        <table className="w-full text-sm">
          <tbody>
            {rows.map(([label, amount]) => (
              <tr key={label} className="border-b border-slate-100 last:border-0">
                <td className="py-1.5 text-slate-600">{label}</td>
                <td className="py-1.5 text-right font-medium">{money(amount)}</td>
              </tr>
            ))}
            <tr>
              <td className="pt-2 font-semibold">Total overdue</td>
              <td className="pt-2 text-right font-semibold">{money(data.total)}</td>
            </tr>
          </tbody>
        </table>
      )}
    </div>
  );
}

export default async function ReceivablesPage() {
  await requireModule('finance');
  const { summary, aging } = await getAccountsReceivableDashboard();

  return (
    <div>
      <PageHeader
        title="Accounts Receivable"
        subtitle="What customers owe, and how overdue it is"
        actions={
          <Link href="/finance" className="btn-secondary">Back to Finance</Link>
        }
      />

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-4 mb-6">
        <Stat
          label="Total outstanding"
          value={money(summary.totalOutstanding)}
          sub={`${summary.totalOutstandingCount} open invoice${summary.totalOutstandingCount === 1 ? '' : 's'}`}
          color="text-blue-600"
        />
        <Stat
          label="Current"
          value={money(summary.current)}
          sub={`${summary.currentCount} not yet due`}
          color="text-green-600"
        />
        <Stat
          label="Overdue"
          value={money(summary.overdue)}
          sub={`${summary.overdueCount} past due`}
          color="text-red-600"
        />
        <Stat
          label="Partially paid"
          value={money(summary.partiallyPaid)}
          sub={`${summary.partiallyPaidCount} invoice${summary.partiallyPaidCount === 1 ? '' : 's'} with a payment on file`}
          color="text-amber-600"
        />
        <Stat
          label="Paid"
          value={money(summary.paid)}
          sub={`${summary.paidCount} invoice${summary.paidCount === 1 ? '' : 's'} fully paid`}
          color="text-slate-500"
        />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <AgingCard data={aging} />
      </div>

      <p className="text-xs text-slate-400 mt-4">
        Figures are derived on the fly from Invoice and Payment records — nothing here is a separately
        stored total. &quot;Current&quot; and &quot;Overdue&quot; are computed from each invoice&apos;s due
        date, so they&apos;re accurate even between scheduled overdue checks. See{' '}
        <code>docs/ACCOUNTS_RECEIVABLE.md</code> for the exact calculation rules.
      </p>
    </div>
  );
}
