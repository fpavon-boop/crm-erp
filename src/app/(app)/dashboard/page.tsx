import Link from 'next/link';
import { prisma } from '@/lib/prisma';
import { requireModule } from '@/lib/session';
import PageHeader from '@/components/PageHeader';
import Badge from '@/components/Badge';
import { money, formatDate } from '@/lib/format';
import SalesChart from './SalesChart';

export default async function DashboardPage() {
  await requireModule('dashboard');

  const now = new Date();
  const sixMonthsAgo = new Date(now.getFullYear(), now.getMonth() - 5, 1);

  const [
    paidInvoicesThisMonth,
    unpaidInvoices,
    pendingOrders,
    lowStockLevels,
    pendingTasks,
    recentInvoicesForChart,
  ] = await Promise.all([
    prisma.invoice.aggregate({
      where: { status: 'PAID', issueDate: { gte: new Date(now.getFullYear(), now.getMonth(), 1) } },
      _sum: { total: true },
    }),
    prisma.invoice.findMany({
      where: { status: { in: ['SENT', 'PARTIAL', 'OVERDUE'] } },
      include: { company: true },
      orderBy: { dueDate: 'asc' },
      take: 8,
    }),
    prisma.salesOrder.findMany({
      where: { status: { in: ['DRAFT', 'CONFIRMED'] } },
      include: { company: true },
      orderBy: { createdAt: 'desc' },
      take: 8,
    }),
    prisma.stockLevel.findMany({
      include: { productVariant: { include: { product: true } }, warehouse: true },
    }),
    prisma.task.findMany({
      where: { status: { in: ['TODO', 'IN_PROGRESS'] } },
      include: { assignee: true },
      orderBy: { dueDate: 'asc' },
      take: 8,
    }),
    prisma.invoice.findMany({
      where: { issueDate: { gte: sixMonthsAgo } },
      select: { issueDate: true, total: true, status: true },
    }),
  ]);

  const lowStock = lowStockLevels.filter(
    (l) => l.productVariant.product.trackInventory && l.quantity <= l.productVariant.product.reorderPoint
  );

  const unpaidTotal = unpaidInvoices.reduce((s, i) => s + (Number(i.total) - Number(i.amountPaid)), 0);

  const chartMap = new Map<string, number>();
  for (let i = 5; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    chartMap.set(d.toLocaleString('en-US', { month: 'short' }), 0);
  }
  for (const inv of recentInvoicesForChart) {
    const key = inv.issueDate.toLocaleString('en-US', { month: 'short' });
    if (chartMap.has(key)) chartMap.set(key, (chartMap.get(key) || 0) + Number(inv.total));
  }
  const chartData = Array.from(chartMap.entries()).map(([month, total]) => ({ month, total }));

  return (
    <div>
      <PageHeader title="Dashboard" subtitle={`Welcome back — ${now.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })}`} />

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
        <StatCard label="Paid this month" value={money(paidInvoicesThisMonth._sum.total || 0)} color="text-green-600" />
        <StatCard label="Unpaid invoices" value={money(unpaidTotal)} sub={`${unpaidInvoices.length} invoices`} color="text-red-600" />
        <StatCard label="Pending orders" value={String(pendingOrders.length)} color="text-blue-600" />
        <StatCard label="Low stock items" value={String(lowStock.length)} color="text-amber-600" />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 mb-6">
        <div className="lg:col-span-2 card p-5">
          <h2 className="font-semibold text-slate-800 mb-3">Revenue (last 6 months, all invoices)</h2>
          <SalesChart data={chartData} />
        </div>
        <div className="card p-5">
          <h2 className="font-semibold text-slate-800 mb-3">Pending tasks</h2>
          <ul className="text-sm space-y-2">
            {pendingTasks.map((t) => (
              <li key={t.id} className="border-b border-slate-100 pb-2">
                <p className="font-medium">{t.title}</p>
                <p className="text-xs text-slate-500">{t.assignee?.name || 'Unassigned'} {t.dueDate && `· ${formatDate(t.dueDate)}`}</p>
              </li>
            ))}
            {pendingTasks.length === 0 && <p className="text-slate-400">No pending tasks.</p>}
          </ul>
          <Link href="/tasks" className="text-xs text-brand-700 hover:underline mt-2 inline-block">View all tasks</Link>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="card p-5">
          <h2 className="font-semibold text-slate-800 mb-3">Unpaid invoices</h2>
          <ul className="text-sm space-y-2">
            {unpaidInvoices.map((i) => (
              <li key={i.id} className="flex justify-between border-b border-slate-100 pb-2">
                <Link href={`/invoicing/${i.id}`} className="text-brand-700 hover:underline">{i.number}</Link>
                <div className="text-right">
                  <Badge label={i.status} />
                  <p className="text-xs text-slate-500">{money(Number(i.total) - Number(i.amountPaid))}</p>
                </div>
              </li>
            ))}
            {unpaidInvoices.length === 0 && <p className="text-slate-400">No unpaid invoices.</p>}
          </ul>
        </div>

        <div className="card p-5">
          <h2 className="font-semibold text-slate-800 mb-3">Pending orders</h2>
          <ul className="text-sm space-y-2">
            {pendingOrders.map((o) => (
              <li key={o.id} className="flex justify-between border-b border-slate-100 pb-2">
                <Link href={`/sales/orders/${o.id}`} className="text-brand-700 hover:underline">{o.number}</Link>
                <Badge label={o.status} />
              </li>
            ))}
            {pendingOrders.length === 0 && <p className="text-slate-400">No pending orders.</p>}
          </ul>
        </div>

        <div className="card p-5">
          <h2 className="font-semibold text-slate-800 mb-3">Low stock items</h2>
          <ul className="text-sm space-y-2">
            {lowStock.map((l) => (
              <li key={l.id} className="flex justify-between border-b border-slate-100 pb-2">
                <Link href={`/inventory/${l.productVariant.productId}`} className="text-brand-700 hover:underline">
                  {l.productVariant.product.name}
                </Link>
                <span className="text-red-600 font-semibold">{l.quantity} left</span>
              </li>
            ))}
            {lowStock.length === 0 && <p className="text-slate-400">All stock levels healthy.</p>}
          </ul>
        </div>
      </div>
    </div>
  );
}

function StatCard({ label, value, sub, color }: { label: string; value: string; sub?: string; color: string }) {
  return (
    <div className="card p-5">
      <p className="text-xs text-slate-500 mb-1">{label}</p>
      <p className={`text-2xl font-bold ${color}`}>{value}</p>
      {sub && <p className="text-xs text-slate-400 mt-1">{sub}</p>}
    </div>
  );
}
