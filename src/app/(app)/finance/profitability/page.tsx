import Link from 'next/link';
import { requireModule } from '@/lib/session';
import PageHeader from '@/components/PageHeader';
import Badge from '@/components/Badge';
import { getProfitabilityDashboard, type ProfitabilitySummary } from '@/lib/profitability';
import { money, formatDate } from '@/lib/format';

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

function marginLabel(summary: ProfitabilitySummary): string {
  if (summary.grossMarginPercent === null) {
    return summary.revenue === 0 ? 'n/a (no revenue)' : 'unknown';
  }
  return `${summary.grossMarginPercent.toFixed(1)}%`;
}

function cogsLabel(summary: ProfitabilitySummary): string {
  if (summary.cogs !== null) return money(summary.cogs);
  return `${money(summary.knownCogs)}+`;
}

function grossProfitLabel(summary: ProfitabilitySummary): string {
  if (summary.grossProfit !== null) return money(summary.grossProfit);
  return `${money(summary.partialGrossProfit)}+`;
}

function parseDate(value: string | undefined): Date | undefined {
  if (!value) return undefined;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

export default async function ProfitabilityPage({
  searchParams,
}: {
  searchParams: { from?: string; to?: string };
}) {
  await requireModule('finance');

  const from = parseDate(searchParams.from);
  // Include the entire "to" day, not just its midnight.
  const to = parseDate(searchParams.to);
  const toInclusive = to ? new Date(to.getTime() + 24 * 60 * 60 * 1000 - 1) : undefined;

  const dashboard = await getProfitabilityDashboard({ from, to: toInclusive });
  const { overall } = dashboard;

  return (
    <div>
      <PageHeader
        title="Profitability"
        subtitle="Revenue, product cost (COGS), and gross margin across the business"
        actions={<Link href="/finance" className="btn-secondary">Back to Finance</Link>}
      />

      <form className="card p-4 mb-4 flex flex-wrap items-end gap-3" method="get">
        <div>
          <label className="block text-xs text-slate-500 mb-1">From</label>
          <input type="date" name="from" defaultValue={searchParams.from} className="input" />
        </div>
        <div>
          <label className="block text-xs text-slate-500 mb-1">To</label>
          <input type="date" name="to" defaultValue={searchParams.to} className="input" />
        </div>
        <button type="submit" className="btn-primary">Apply</button>
        {(searchParams.from || searchParams.to) && (
          <Link href="/finance/profitability" className="btn-secondary">Clear</Link>
        )}
        <p className="text-xs text-slate-400 ml-auto">
          Sales orders that are Confirmed, Shipped, or Delivered — matching &quot;Orders sold&quot; on the
          Finance page.
        </p>
      </form>

      {overall.hasUnknownCost && (
        <div className="card p-4 mb-4 border-amber-300 bg-amber-50 text-amber-900 text-sm">
          <strong>{overall.unknownCostLineCount}</strong> product line{overall.unknownCostLineCount === 1 ? '' : 's'}{' '}
          totaling <strong>{money(overall.unknownCostRevenue)}</strong> in revenue have no determinable cost (no
          purchase history and no standard cost set), so total COGS and gross margin below are shown as a floor
          (&quot;X+&quot;), not a final figure. See <code>docs/PROFITABILITY_REPORTING.md</code>.
        </div>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
        <Stat label="Revenue" value={money(overall.revenue)} color="text-blue-600" />
        <Stat
          label="COGS"
          value={cogsLabel(overall)}
          sub={overall.hasUnknownCost ? 'partial — some costs unknown' : 'product cost'}
          color="text-red-600"
        />
        <Stat
          label="Gross profit"
          value={grossProfitLabel(overall)}
          sub={overall.hasUnknownCost ? 'at least this much' : 'revenue − COGS'}
          color={(overall.grossProfit ?? overall.partialGrossProfit) >= 0 ? 'text-green-600' : 'text-red-600'}
        />
        <Stat label="Gross margin" value={marginLabel(overall)} color="text-slate-700" />
      </div>

      <div className="card overflow-x-auto mb-6">
        <div className="p-4 pb-0"><h2 className="font-semibold text-slate-800">Monthly trend</h2></div>
        <table className="table-base">
          <thead>
            <tr><th>Month</th><th className="text-right">Revenue</th><th className="text-right">COGS</th><th className="text-right">Gross profit</th><th className="text-right">Margin</th></tr>
          </thead>
          <tbody>
            {dashboard.byMonth.map((m) => (
              <tr key={m.key}>
                <td className="font-medium">{m.label}</td>
                <td className="text-right">{money(m.summary.revenue)}</td>
                <td className="text-right">{cogsLabel(m.summary)}</td>
                <td className="text-right">{grossProfitLabel(m.summary)}</td>
                <td className="text-right">{marginLabel(m.summary)}</td>
              </tr>
            ))}
            {dashboard.byMonth.length === 0 && (
              <tr><td colSpan={5} className="text-center text-slate-500 py-8">No sold orders in this range.</td></tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-6">
        <div className="card overflow-x-auto">
          <div className="p-4 pb-0"><h2 className="font-semibold text-slate-800">By product</h2></div>
          <table className="table-base">
            <thead>
              <tr><th>Product</th><th className="text-right">Qty</th><th className="text-right">Revenue</th><th className="text-right">Margin</th></tr>
            </thead>
            <tbody>
              {dashboard.byProduct.slice(0, 20).map((p) => (
                <tr key={p.productId}>
                  <td>
                    <div className="font-medium">{p.name}</div>
                    <div className="text-xs text-slate-400">{p.sku}{p.summary.hasUnknownCost ? ' · cost unknown' : ''}</div>
                  </td>
                  <td className="text-right">{p.quantitySold}</td>
                  <td className="text-right">{money(p.summary.revenue)}</td>
                  <td className="text-right">{marginLabel(p.summary)}</td>
                </tr>
              ))}
              {dashboard.byProduct.length === 0 && (
                <tr><td colSpan={4} className="text-center text-slate-500 py-8">No product sales in this range.</td></tr>
              )}
            </tbody>
          </table>
        </div>

        <div className="card overflow-x-auto">
          <div className="p-4 pb-0"><h2 className="font-semibold text-slate-800">By customer</h2></div>
          <table className="table-base">
            <thead>
              <tr><th>Customer</th><th className="text-right">Orders</th><th className="text-right">Revenue</th><th className="text-right">Margin</th></tr>
            </thead>
            <tbody>
              {dashboard.byCustomer.slice(0, 20).map((c) => (
                <tr key={c.companyId ?? 'unassigned'}>
                  <td className="font-medium">{c.companyName}</td>
                  <td className="text-right">{c.orderCount}</td>
                  <td className="text-right">{money(c.summary.revenue)}</td>
                  <td className="text-right">{marginLabel(c.summary)}</td>
                </tr>
              ))}
              {dashboard.byCustomer.length === 0 && (
                <tr><td colSpan={4} className="text-center text-slate-500 py-8">No customer sales in this range.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      <div className="card overflow-x-auto">
        <div className="p-4 pb-0"><h2 className="font-semibold text-slate-800">By order</h2></div>
        <table className="table-base">
          <thead>
            <tr><th>Order</th><th>Status</th><th>Date</th><th>Customer</th><th className="text-right">Revenue</th><th className="text-right">Gross profit</th><th className="text-right">Margin</th></tr>
          </thead>
          <tbody>
            {dashboard.byOrder.slice(0, 25).map((o) => (
              <tr key={o.orderId}>
                <td className="font-medium">{o.number}</td>
                <td><Badge label={o.status} /></td>
                <td>{formatDate(o.createdAt)}</td>
                <td>{o.companyName ?? '—'}</td>
                <td className="text-right">{money(o.summary.revenue)}</td>
                <td className="text-right">{grossProfitLabel(o.summary)}</td>
                <td className="text-right">{marginLabel(o.summary)}</td>
              </tr>
            ))}
            {dashboard.byOrder.length === 0 && (
              <tr><td colSpan={7} className="text-center text-slate-500 py-8">No sold orders in this range.</td></tr>
            )}
          </tbody>
        </table>
      </div>

      <p className="text-xs text-slate-400 mt-4">
        Product cost is a purchase-history weighted average where available, falling back to each product&apos;s
        standard cost, and is never assumed to be zero when unknown. Shipping charged to customers is included in
        revenue; shipping/payment-processing/platform fees are not tracked per-order in this system and are
        excluded from these figures. See <code>docs/PROFITABILITY_REPORTING.md</code> for the full methodology.
      </p>
    </div>
  );
}
