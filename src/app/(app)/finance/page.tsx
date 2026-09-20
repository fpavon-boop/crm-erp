import Link from 'next/link';
import { requireModule } from '@/lib/session';
import PageHeader from '@/components/PageHeader';
import { getFinanceSummary, type AgingBuckets } from '@/lib/finance';
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

function AgingCard({ title, data, empty }: { title: string; data: AgingBuckets; empty: string }) {
  const rows: Array<[string, number]> = [
    ['Not due yet', data.notDue],
    ['1–30 days late', data.d1to30],
    ['31–60 days late', data.d31to60],
    ['Over 60 days late', data.over60],
  ];
  return (
    <div className="card p-5">
      <div className="flex items-baseline justify-between mb-3">
        <h2 className="font-semibold text-slate-800">{title}</h2>
        <span className="text-xs text-slate-500">{data.count} open</span>
      </div>
      {data.count === 0 ? (
        <p className="text-sm text-slate-400">{empty}</p>
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
              <td className="pt-2 font-semibold">Total</td>
              <td className="pt-2 text-right font-semibold">{money(data.total)}</td>
            </tr>
          </tbody>
        </table>
      )}
    </div>
  );
}

export default async function FinancePage() {
  await requireModule('finance');
  const { months, current, receivables, payables, categories } = await getFinanceSummary();

  return (
    <div>
      <PageHeader
        title="Finance"
        subtitle="Money in, money out, and what is still owed"
        actions={<Link href="/finance/expenses" className="btn-primary">Expenses</Link>}
      />

      <p className="text-sm text-slate-500 mb-3">This month ({current.label})</p>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
        <Stat label="Orders sold" value={money(current.sold)} sub="Confirmed, shipped or delivered (includes WooCommerce)" color="text-blue-600" />
        <Stat label="Money received" value={money(current.received)} sub="Payments recorded on invoices" color="text-green-600" />
        <Stat label="Money paid out" value={money(current.paidOut)} sub="Bill payments plus expenses" color="text-red-600" />
        <Stat
          label="Net cash"
          value={money(current.net)}
          sub="Received minus paid out"
          color={current.net >= 0 ? 'text-green-600' : 'text-red-600'}
        />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-6">
        <AgingCard title="Customers owe you" data={receivables} empty="No open customer invoices." />
        <AgingCard title="You owe suppliers" data={payables} empty="No open supplier bills." />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <div className="card overflow-x-auto lg:col-span-2">
          <table className="table-base">
            <thead>
              <tr><th>Month</th><th className="text-right">Orders sold</th><th className="text-right">Received</th><th className="text-right">Paid out</th><th className="text-right">Net cash</th></tr>
            </thead>
            <tbody>
              {[...months].reverse().map((m) => (
                <tr key={m.key}>
                  <td className="font-medium">{m.label}</td>
                  <td className="text-right">{money(m.sold)}</td>
                  <td className="text-right text-green-700">{money(m.received)}</td>
                  <td className="text-right text-red-700">{money(m.paidOut)}</td>
                  <td className={`text-right font-medium ${m.net >= 0 ? 'text-green-700' : 'text-red-700'}`}>{money(m.net)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="card p-5">
          <h2 className="font-semibold text-slate-800 mb-3">Expenses this month</h2>
          {categories.length === 0 ? (
            <p className="text-sm text-slate-400">No expenses recorded this month.</p>
          ) : (
            <table className="w-full text-sm">
              <tbody>
                {categories.map((c) => (
                  <tr key={c.category} className="border-b border-slate-100 last:border-0">
                    <td className="py-1.5 text-slate-600">{c.category}</td>
                    <td className="py-1.5 text-right font-medium">{money(c.total)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>

      <p className="text-xs text-slate-400 mt-4">
        Money received counts payments recorded on invoices. WooCommerce orders paid online show under Orders sold, and are not double-counted as received.
      </p>
    </div>
  );
}
