import { prisma } from '@/lib/prisma';
import { toNumber } from '@/lib/format';

export const EXPENSE_CATEGORIES = [
  'Rent / Utilities',
  'Payroll / Labor',
  'Fuel / Vehicle',
  'Shipping / Freight',
  'Tools / Equipment',
  'Materials / Supplies',
  'Marketing / Advertising',
  'Software / Subscriptions',
  'Insurance',
  'Taxes / Fees',
  'Professional services',
  'Other',
] as const;

export const PAYMENT_METHODS = ['Bank transfer', 'Check', 'Cash', 'Card', 'Zelle / ACH', 'Other'] as const;

export interface MonthRow {
  key: string;
  label: string;
  sold: number; // confirmed / shipped / delivered orders (includes WooCommerce)
  received: number; // customer payments recorded on invoices
  paidOut: number; // supplier payments + expenses
  net: number;
}

export interface AgingBuckets {
  notDue: number;
  d1to30: number;
  d31to60: number;
  over60: number;
  total: number;
  count: number;
}

function monthStart(d: Date, offset = 0) {
  return new Date(d.getFullYear(), d.getMonth() + offset, 1);
}

function monthKey(d: Date) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function aging(rows: Array<{ open: number; due: Date | null; issued: Date }>, now: Date): AgingBuckets {
  const b: AgingBuckets = { notDue: 0, d1to30: 0, d31to60: 0, over60: 0, total: 0, count: 0 };
  for (const r of rows) {
    if (r.open <= 0) continue;
    const ref = r.due ?? r.issued;
    const daysLate = Math.floor((now.getTime() - ref.getTime()) / 86_400_000);
    if (daysLate <= 0) b.notDue += r.open;
    else if (daysLate <= 30) b.d1to30 += r.open;
    else if (daysLate <= 60) b.d31to60 += r.open;
    else b.over60 += r.open;
    b.total += r.open;
    b.count += 1;
  }
  return b;
}

export async function getFinanceSummary(now = new Date()) {
  const from = monthStart(now, -5);

  const [orders, payments, supplierPayments, expenses, openInvoices, openBills] = await Promise.all([
    prisma.salesOrder.findMany({
      where: { status: { in: ['CONFIRMED', 'SHIPPED', 'DELIVERED'] }, createdAt: { gte: from } },
      select: { total: true, createdAt: true },
    }),
    prisma.payment.findMany({ where: { paidAt: { gte: from } }, select: { amount: true, paidAt: true } }),
    prisma.supplierPayment.findMany({ where: { paidAt: { gte: from } }, select: { amount: true, paidAt: true } }),
    prisma.expense.findMany({
      where: { expenseDate: { gte: from } },
      select: { amount: true, expenseDate: true, category: true },
    }),
    prisma.invoice.findMany({
      where: { type: 'INVOICE', status: { in: ['SENT', 'PARTIAL', 'OVERDUE'] } },
      select: { total: true, amountPaid: true, dueDate: true, issueDate: true },
    }),
    prisma.supplierInvoice.findMany({
      where: { status: { not: 'PAID' } },
      select: { amount: true, amountPaid: true, dueDate: true, issueDate: true },
    }),
  ]);

  const months: MonthRow[] = [];
  for (let i = 5; i >= 0; i -= 1) {
    const d = monthStart(now, -i);
    months.push({
      key: monthKey(d),
      label: d.toLocaleDateString('en-US', { month: 'short', year: 'numeric' }),
      sold: 0,
      received: 0,
      paidOut: 0,
      net: 0,
    });
  }
  const byKey = new Map(months.map((m) => [m.key, m]));

  for (const o of orders) {
    const m = byKey.get(monthKey(o.createdAt));
    if (m) m.sold += toNumber(o.total);
  }
  for (const p of payments) {
    const m = byKey.get(monthKey(p.paidAt));
    if (m) m.received += toNumber(p.amount);
  }
  for (const p of supplierPayments) {
    const m = byKey.get(monthKey(p.paidAt));
    if (m) m.paidOut += toNumber(p.amount);
  }
  const thisKey = monthKey(now);
  const categoryTotals = new Map<string, number>();
  for (const e of expenses) {
    const m = byKey.get(monthKey(e.expenseDate));
    if (m) m.paidOut += toNumber(e.amount);
    if (monthKey(e.expenseDate) === thisKey) {
      categoryTotals.set(e.category, (categoryTotals.get(e.category) ?? 0) + toNumber(e.amount));
    }
  }
  for (const m of months) m.net = m.received - m.paidOut;

  const receivables = aging(
    openInvoices.map((i) => ({
      open: toNumber(i.total) - toNumber(i.amountPaid),
      due: i.dueDate,
      issued: i.issueDate,
    })),
    now
  );
  const payables = aging(
    openBills.map((b) => ({
      open: toNumber(b.amount) - toNumber(b.amountPaid),
      due: b.dueDate,
      issued: b.issueDate,
    })),
    now
  );

  const categories = [...categoryTotals.entries()]
    .map(([category, total]) => ({ category, total }))
    .sort((a, b) => b.total - a.total);

  return { months, current: months[months.length - 1], receivables, payables, categories };
}
