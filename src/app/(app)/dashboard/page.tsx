import Link from 'next/link';
import type { Role } from '@prisma/client';
import { requireModule } from '@/lib/session';
import PageHeader from '@/components/PageHeader';
import Badge from '@/components/Badge';
import AiSummaryCard from '@/components/ai/AiSummaryCard';
import { money, formatDate, formatDateTime } from '@/lib/format';
import {
  getDashboardData,
  getDashboardFilterOptions,
  type DashboardFilters,
  type SalesChannelFilter,
} from '@/lib/dashboard';
import type { ProfitabilitySummary } from '@/lib/profitability';

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
  if (summary.grossMarginPercent === null) return summary.revenue === 0 ? 'n/a (no revenue)' : 'unknown';
  return `${summary.grossMarginPercent.toFixed(1)}%`;
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

interface DashboardSearchParams {
  from?: string;
  to?: string;
  companyId?: string;
  productId?: string;
  warehouseId?: string;
  channel?: string;
}

/** YYYY-MM-DD in local time, matching what an `<input type="date">` sends
 * — used to build the preset (Today/This Month/This Year) links from the
 * same query params the custom-range inputs already use, so a preset and
 * the matching hand-typed range are indistinguishable to the rest of the
 * page. */
function isoDate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function presetHref(base: DashboardSearchParams, from: string, to: string): string {
  const params = new URLSearchParams({
    ...(base.companyId ? { companyId: base.companyId } : {}),
    ...(base.productId ? { productId: base.productId } : {}),
    ...(base.warehouseId ? { warehouseId: base.warehouseId } : {}),
    ...(base.channel ? { channel: base.channel } : {}),
    from,
    to,
  });
  return `/dashboard?${params.toString()}`;
}

export default async function DashboardPage({ searchParams }: { searchParams: DashboardSearchParams }) {
  const session = await requireModule('dashboard');
  const role = session.user.role as Role;

  const from = parseDate(searchParams.from);
  const to = parseDate(searchParams.to);
  const toInclusive = to ? new Date(to.getTime() + 24 * 60 * 60 * 1000 - 1) : undefined;
  const channel: SalesChannelFilter | undefined =
    searchParams.channel === 'woocommerce' || searchParams.channel === 'direct' ? searchParams.channel : undefined;

  const now = new Date();
  const todayIso = isoDate(now);
  const monthStartIso = isoDate(new Date(now.getFullYear(), now.getMonth(), 1));
  const yearStartIso = isoDate(new Date(now.getFullYear(), 0, 1));
  const datePresets = [
    { label: 'Today', href: presetHref(searchParams, todayIso, todayIso) },
    { label: 'This month', href: presetHref(searchParams, monthStartIso, todayIso) },
    { label: 'This year', href: presetHref(searchParams, yearStartIso, todayIso) },
  ];

  const filters: DashboardFilters = {
    from,
    to: toInclusive,
    companyId: searchParams.companyId || undefined,
    productId: searchParams.productId || undefined,
    warehouseId: searchParams.warehouseId || undefined,
    channel,
  };

  const [data, filterOptions] = await Promise.all([getDashboardData(role, filters), getDashboardFilterOptions()]);

  const hasActiveFilters = Boolean(
    searchParams.from || searchParams.to || searchParams.companyId || searchParams.productId || searchParams.warehouseId || searchParams.channel
  );

  return (
    <div>
      <PageHeader
        title="Dashboard"
        subtitle={`As of ${data.generatedAt.toLocaleString('en-US', { weekday: 'long', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit' })}`}
      />

      <div className="flex flex-wrap items-center gap-2 mb-3">
        <span className="text-xs text-slate-500">Date range:</span>
        {datePresets.map((p) => (
          <Link key={p.label} href={p.href} className="btn-secondary text-xs px-2 py-1">{p.label}</Link>
        ))}
      </div>

      <form className="card p-4 mb-6 flex flex-wrap items-end gap-3" method="get">
        <div>
          <label className="block text-xs text-slate-500 mb-1">From</label>
          <input type="date" name="from" defaultValue={searchParams.from} className="input" />
        </div>
        <div>
          <label className="block text-xs text-slate-500 mb-1">To</label>
          <input type="date" name="to" defaultValue={searchParams.to} className="input" />
        </div>
        <div>
          <label className="block text-xs text-slate-500 mb-1">Customer</label>
          <select name="companyId" defaultValue={searchParams.companyId || ''} className="input">
            <option value="">All customers</option>
            {filterOptions.customers.map((c) => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
          </select>
        </div>
        <div>
          <label className="block text-xs text-slate-500 mb-1">Product</label>
          <select name="productId" defaultValue={searchParams.productId || ''} className="input">
            <option value="">All products</option>
            {filterOptions.products.map((p) => (
              <option key={p.id} value={p.id}>{p.name} ({p.sku})</option>
            ))}
          </select>
        </div>
        <div>
          <label className="block text-xs text-slate-500 mb-1">Warehouse</label>
          <select name="warehouseId" defaultValue={searchParams.warehouseId || ''} className="input">
            <option value="">All warehouses</option>
            {filterOptions.warehouses.map((w) => (
              <option key={w.id} value={w.id}>{w.name}</option>
            ))}
          </select>
        </div>
        <div>
          <label className="block text-xs text-slate-500 mb-1">Sales channel</label>
          <select name="channel" defaultValue={searchParams.channel || ''} className="input">
            <option value="">All channels</option>
            <option value="woocommerce">WooCommerce / Website</option>
            <option value="direct">Direct (manually entered)</option>
          </select>
        </div>
        <button type="submit" className="btn-primary">Apply</button>
        {hasActiveFilters && <Link href="/dashboard" className="btn-secondary">Clear</Link>}
      </form>

      <div className="mb-6">
        <AiSummaryCard title="AI Sales Summary" endpoint="/api/ai/sales-summary" payload={{}} />
      </div>

      <p className="text-xs text-slate-400 mb-2">Sales figures below</p>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 mb-6">
        <Stat label="Sales today" value={money(data.sales.today)} color="text-blue-600" />
        <Stat label="Sales this month" value={money(data.sales.thisMonth)} color="text-blue-600" />
        <Stat label="Sales this year" value={money(data.sales.thisYear)} color="text-blue-600" />
      </div>

      {data.grossProfit && (
        <>
          {data.grossProfit.hasUnknownCost && (
            <div className="card p-4 mb-4 border-amber-300 bg-amber-50 text-amber-900 text-sm">
              <strong>{data.grossProfit.unknownCostLineCount}</strong> order line{data.grossProfit.unknownCostLineCount === 1 ? '' : 's'}{' '}
              have no determinable cost, so gross profit/margin below are shown as a floor (&quot;X+&quot;), not a
              final figure. See <code>docs/MANAGEMENT_DASHBOARD.md</code>.
            </div>
          )}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-2 gap-4 mb-6">
            <Stat
              label="Gross profit"
              value={grossProfitLabel(data.grossProfit)}
              sub={from || to ? 'in selected date range' : 'year to date'}
              color={(data.grossProfit.grossProfit ?? data.grossProfit.partialGrossProfit) >= 0 ? 'text-green-600' : 'text-red-600'}
            />
            <Stat label="Gross margin" value={marginLabel(data.grossProfit)} color="text-slate-700" />
          </div>
        </>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
        <Stat
          label="Outstanding invoices"
          value={money(data.receivables.outstanding.total)}
          sub={`${data.receivables.outstanding.count} open invoice${data.receivables.outstanding.count === 1 ? '' : 's'}`}
          color="text-blue-600"
        />
        <Stat
          label="Overdue invoices"
          value={money(data.receivables.overdue.total)}
          sub={`${data.receivables.overdue.count} past due`}
          color="text-red-600"
        />
        {data.inventoryValue && (
          <Stat
            label="Inventory value"
            value={money(data.inventoryValue.knownValue)}
            sub={data.inventoryValue.hasUnknownCost ? `+ ${data.inventoryValue.unknownCostUnits} units of unknown cost` : 'known cost only'}
            color="text-slate-700"
          />
        )}
        <Stat label="Low-stock products" value={String(data.lowStock.length)} color="text-amber-600" />
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 mb-6">
        <Stat
          label="Open quotes"
          value={String(data.open.quotes.count)}
          sub={money(data.open.quotes.total)}
          color="text-slate-700"
        />
        <Stat
          label="Open sales orders"
          value={String(data.open.salesOrders.count)}
          sub={money(data.open.salesOrders.total)}
          color="text-slate-700"
        />
        <Stat
          label="Open purchase orders"
          value={String(data.open.purchaseOrders.count)}
          sub={money(data.open.purchaseOrders.total)}
          color="text-slate-700"
        />
      </div>

      <div className="card overflow-x-auto mb-6">
        <div className="p-4 pb-0"><h2 className="font-semibold text-slate-800">Low-stock products</h2></div>
        <table className="table-base">
          <thead>
            <tr><th>Product</th><th>Warehouse</th><th className="text-right">On hand</th><th className="text-right">Reorder point</th></tr>
          </thead>
          <tbody>
            {data.lowStock.slice(0, 25).map((l, i) => (
              <tr key={`${l.productId}-${i}`}>
                <td>
                  <Link href={`/inventory/${l.productId}`} className="text-brand-700 hover:underline font-medium">{l.name}</Link>
                  <div className="text-xs text-slate-400">{l.sku}</div>
                </td>
                <td>{l.warehouseName}</td>
                <td className="text-right text-red-600 font-semibold">{l.quantity}</td>
                <td className="text-right">{l.reorderPoint}</td>
              </tr>
            ))}
            {data.lowStock.length === 0 && (
              <tr><td colSpan={4} className="text-center text-slate-500 py-8">All stock levels healthy.</td></tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <div className="card overflow-x-auto">
          <div className="p-4 pb-0"><h2 className="font-semibold text-slate-800">Recent orders</h2></div>
          <ul className="text-sm divide-y divide-slate-100">
            {data.recent.orders.map((o) => (
              <li key={o.id} className="p-3 flex justify-between items-start gap-2">
                <div>
                  <Link href={`/sales/orders/${o.id}`} className="text-brand-700 hover:underline font-medium">{o.number}</Link>
                  <p className="text-xs text-slate-400">{o.companyName ?? '—'} · {formatDate(o.createdAt)}</p>
                </div>
                <div className="text-right">
                  <Badge label={o.status} />
                  <p className="text-xs text-slate-500 mt-1">{money(o.total)}</p>
                </div>
              </li>
            ))}
            {data.recent.orders.length === 0 && <li className="p-6 text-center text-slate-400">No orders match these filters.</li>}
          </ul>
        </div>

        <div className="card overflow-x-auto">
          <div className="p-4 pb-0"><h2 className="font-semibold text-slate-800">Recent payments</h2></div>
          <ul className="text-sm divide-y divide-slate-100">
            {data.recent.payments.map((p) => (
              <li key={p.id} className="p-3 flex justify-between items-start gap-2">
                <div>
                  <p className="font-medium">{p.invoiceNumber}</p>
                  <p className="text-xs text-slate-400">{p.companyName ?? '—'} · {formatDate(p.paidAt)}</p>
                </div>
                <div className="text-right">
                  <p className="font-semibold text-green-600">{money(p.amount)}</p>
                  <p className="text-xs text-slate-500">{p.method}</p>
                </div>
              </li>
            ))}
            {data.recent.payments.length === 0 && <li className="p-6 text-center text-slate-400">No payments match these filters.</li>}
          </ul>
        </div>

        <div className="card overflow-x-auto">
          <div className="p-4 pb-0"><h2 className="font-semibold text-slate-800">Recent inventory movements</h2></div>
          <ul className="text-sm divide-y divide-slate-100">
            {data.recent.movements.map((m) => (
              <li key={m.id} className="p-3 flex justify-between items-start gap-2">
                <div>
                  <p className="font-medium">{m.productName}</p>
                  <p className="text-xs text-slate-400">
                    {m.sku} · {m.variantName} · {m.warehouseName} · {formatDateTime(m.createdAt)}
                    {m.referenceType && <> · ref: {m.referenceType}</>}
                  </p>
                </div>
                <div className="text-right">
                  <Badge label={m.type} />
                  <p className={`text-xs mt-1 font-semibold ${m.quantity >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                    {m.quantity >= 0 ? '+' : ''}{m.quantity}
                  </p>
                </div>
              </li>
            ))}
            {data.recent.movements.length === 0 && <li className="p-6 text-center text-slate-400">No inventory movements match these filters.</li>}
          </ul>
        </div>
      </div>

      <p className="text-xs text-slate-400 mt-4">
        Every figure above is computed on the fly from real Sales Order, Invoice, Payment, Purchase Order, and
        Stock Level/Movement records — nothing is estimated or hard-coded. The date range applies to Gross
        profit/margin and the &quot;Recent&quot; lists; Sales today/this month/this year are always their own fixed
        periods, and current-state figures (Outstanding/Overdue, Inventory value, Low-stock, Open documents)
        always reflect right now. See <code>docs/MANAGEMENT_DASHBOARD.md</code> for the exact definition of every figure and
        which filters apply to which.
      </p>
    </div>
  );
}
