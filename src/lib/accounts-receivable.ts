import { prisma } from '@/lib/prisma';
import type { InvoiceStatus } from '@prisma/client';
import { computeTotals } from '@/lib/totals';
import { toNumber } from '@/lib/format';

/**
 * Statuses this module (and every place that records a payment) treats as
 * "open" — the invoice has been issued and isn't fully resolved yet. DRAFT
 * (not yet issued) and CANCELLED (voided) are excluded from every
 * receivable/aging calculation, matching the existing manual-payment route
 * and Stripe webhook's behavior. There is no separate VOID status in this
 * schema — CANCELLED is the terminal non-payable state (see
 * docs/ACCOUNTS_RECEIVABLE.md, "Status mapping").
 */
const OPEN_STATUSES: InvoiceStatus[] = ['SENT', 'PARTIAL', 'OVERDUE'];

export interface InvoiceFinancialInput {
  status: InvoiceStatus;
  total: number;
  amountPaid: number;
  dueDate: Date | null;
}

/**
 * The single, authoritative rule for "what status should this invoice have
 * right now", given its actual financial state and due date — pure and
 * deterministic (same inputs always produce the same status), so it's
 * usable both as a live/on-the-fly classifier (the AR dashboard, without
 * writing anything) and as the one place that decides what to *write* when
 * something changes an invoice's balance (a payment, a refund, or the
 * overdue-check scheduler tick).
 *
 * DRAFT and CANCELLED are terminal/manually-set states this function never
 * overrides — nothing here un-cancels an invoice or "un-drafts" one.
 *
 * Precedence for everything else: PAID (fully covered) beats OVERDUE (past
 * due) beats PARTIAL/SENT (whether anything has been paid yet). This
 * matches every existing call site's actual behavior today (a payment
 * that fully pays an already-OVERDUE invoice must mark it PAID, not leave
 * it OVERDUE) and is exercised directly in
 * tests/accounts-receivable.test.ts.
 */
export function deriveInvoiceStatus(input: InvoiceFinancialInput, now: Date = new Date()): InvoiceStatus {
  if (input.status === 'DRAFT' || input.status === 'CANCELLED') return input.status;
  if (input.total <= 0 || input.amountPaid >= input.total) return 'PAID';
  if (input.dueDate !== null && input.dueDate.getTime() < now.getTime()) return 'OVERDUE';
  return input.amountPaid > 0 ? 'PARTIAL' : 'SENT';
}

/** Never negative — an overpaid invoice (see docs/ACCOUNTS_RECEIVABLE.md
 * "Known limitations") owes nothing further, not a negative balance. */
export function computeBalanceDue(total: number, amountPaid: number): number {
  return Math.max(0, Math.round((total - amountPaid) * 100) / 100);
}

export interface InvoiceFinancialDiscrepancy {
  field: string;
  stored: number | string;
  expected: number | string;
}

export interface VerifyInvoiceFinancialsResult {
  consistent: boolean;
  discrepancies: InvoiceFinancialDiscrepancy[];
  balanceDue: number;
  expectedStatus: InvoiceStatus;
}

/**
 * Recomputes an invoice's subtotal/tax/discount/total from its own line
 * items (the exact same computeTotals() used when the invoice is
 * created/edited) and compares against the stored values — flags any
 * drift beyond a one-cent rounding tolerance rather than silently trusting
 * stored totals. Also flags if the stored `status` doesn't match what
 * deriveInvoiceStatus() says it should be right now. This never writes
 * anything; it's a read-only integrity check (see docs/ACCOUNTS_RECEIVABLE.md
 * "Verification, not silent trust").
 */
export function verifyInvoiceFinancials(
  invoice: {
    status: InvoiceStatus;
    subtotal: number;
    taxTotal: number;
    discountTotal: number;
    total: number;
    amountPaid: number;
    dueDate: Date | null;
  },
  items: Array<{ quantity: number; unitPrice: number; taxRate: number; discount: number }>,
  now: Date = new Date()
): VerifyInvoiceFinancialsResult {
  const expected = computeTotals(items);
  const discrepancies: InvoiceFinancialDiscrepancy[] = [];
  const TOLERANCE = 0.01;

  const checks: Array<[string, number, number]> = [
    ['subtotal', invoice.subtotal, expected.subtotal],
    ['taxTotal', invoice.taxTotal, expected.taxTotal],
    ['discountTotal', invoice.discountTotal, expected.discountTotal],
    ['total', invoice.total, expected.total],
  ];
  for (const [field, stored, expectedValue] of checks) {
    if (Math.abs(stored - expectedValue) > TOLERANCE) {
      discrepancies.push({ field, stored, expected: expectedValue });
    }
  }

  const expectedStatus = deriveInvoiceStatus(
    { status: invoice.status, total: invoice.total, amountPaid: invoice.amountPaid, dueDate: invoice.dueDate },
    now
  );
  if (expectedStatus !== invoice.status) {
    discrepancies.push({ field: 'status', stored: invoice.status, expected: expectedStatus });
  }

  return {
    consistent: discrepancies.length === 0,
    discrepancies,
    balanceDue: computeBalanceDue(invoice.total, invoice.amountPaid),
    expectedStatus,
  };
}

export interface ARSummary {
  totalOutstanding: number;
  totalOutstandingCount: number;
  current: number;
  currentCount: number;
  overdue: number;
  overdueCount: number;
  partiallyPaid: number;
  partiallyPaidCount: number;
  paid: number;
  paidCount: number;
}

/**
 * The five AR dashboard aggregations, computed on the fly from real
 * Invoice rows — never a second, separately-maintained total.
 * `current`/`overdue` are computed from `dueDate` directly (not from the
 * stored `status`), so the dashboard is accurate even in the up-to-
 * AUTOMATIONS_INTERVAL_MINUTES window before the overdue-check scheduler
 * tick has caught up and flipped a stale SENT/PARTIAL row to OVERDUE — see
 * docs/ACCOUNTS_RECEIVABLE.md "Why current/overdue aren't read from status".
 * `current + overdue === totalOutstanding` by construction (every open
 * invoice is in exactly one of the two). `partiallyPaid` and `paid` are
 * separate, overlapping-by-design metrics, not additional partitions of
 * totalOutstanding — see docs/ACCOUNTS_RECEIVABLE.md "AR summary metrics".
 */
export function summarizeInvoicesForAR(
  invoices: Array<{ status: InvoiceStatus; total: number; amountPaid: number; dueDate: Date | null }>,
  now: Date = new Date()
): ARSummary {
  const summary: ARSummary = {
    totalOutstanding: 0,
    totalOutstandingCount: 0,
    current: 0,
    currentCount: 0,
    overdue: 0,
    overdueCount: 0,
    partiallyPaid: 0,
    partiallyPaidCount: 0,
    paid: 0,
    paidCount: 0,
  };

  for (const invoice of invoices) {
    if (invoice.status === 'PAID') {
      summary.paid += invoice.amountPaid;
      summary.paidCount += 1;
      continue;
    }
    if (!OPEN_STATUSES.includes(invoice.status)) continue; // DRAFT/CANCELLED: not part of AR at all

    const balance = computeBalanceDue(invoice.total, invoice.amountPaid);
    summary.totalOutstanding += balance;
    summary.totalOutstandingCount += 1;

    const isOverdue = invoice.dueDate !== null && invoice.dueDate.getTime() < now.getTime();
    if (isOverdue) {
      summary.overdue += balance;
      summary.overdueCount += 1;
    } else {
      summary.current += balance;
      summary.currentCount += 1;
    }

    if (invoice.amountPaid > 0) {
      summary.partiallyPaid += balance;
      summary.partiallyPaidCount += 1;
    }
  }

  return summary;
}

export interface ARAgingBuckets {
  d0to30: number;
  d31to60: number;
  d61to90: number;
  d90plus: number;
  total: number;
  count: number;
}

/**
 * AR aging, bucketed by how many days PAST due each open invoice's balance
 * is — only invoices that are actually overdue (dueDate < now) are aged;
 * a not-yet-due invoice contributes to ARSummary.current, not to any aging
 * bucket. Boundaries are inclusive of the bucket's upper edge (exactly 30
 * days late is still "0-30", exactly 31 is "31-60") — see
 * docs/ACCOUNTS_RECEIVABLE.md "Aging bucket boundaries" and the boundary
 * tests in tests/accounts-receivable.test.ts.
 */
export function computeARAgingBuckets(
  invoices: Array<{ status: InvoiceStatus; total: number; amountPaid: number; dueDate: Date | null }>,
  now: Date = new Date()
): ARAgingBuckets {
  const buckets: ARAgingBuckets = { d0to30: 0, d31to60: 0, d61to90: 0, d90plus: 0, total: 0, count: 0 };

  for (const invoice of invoices) {
    if (!OPEN_STATUSES.includes(invoice.status)) continue;
    if (invoice.dueDate === null || invoice.dueDate.getTime() >= now.getTime()) continue; // not overdue

    const balance = computeBalanceDue(invoice.total, invoice.amountPaid);
    if (balance <= 0) continue;

    const daysPastDue = Math.floor((now.getTime() - invoice.dueDate.getTime()) / 86_400_000);
    if (daysPastDue <= 30) buckets.d0to30 += balance;
    else if (daysPastDue <= 60) buckets.d31to60 += balance;
    else if (daysPastDue <= 90) buckets.d61to90 += balance;
    else buckets.d90plus += balance;

    buckets.total += balance;
    buckets.count += 1;
  }

  return buckets;
}

export interface AccountsReceivableDashboard {
  summary: ARSummary;
  aging: ARAgingBuckets;
}

/**
 * Fetches every open-or-paid Invoice (type INVOICE only — SupplierInvoice
 * is a separate, already-existing accounts-*payable* concern in
 * src/lib/finance.ts, not part of accounts receivable) and derives both
 * the summary and aging views from the same single query — one read, two
 * ways of looking at it, never two separately-maintained figures.
 *
 * `companyId` narrows this to one customer's invoices (used by the
 * management dashboard's customer filter — see docs/MANAGEMENT_DASHBOARD.md) without
 * duplicating this module's status/balance logic there.
 */
export async function getAccountsReceivableDashboard(
  now: Date = new Date(),
  companyId?: string
): Promise<AccountsReceivableDashboard> {
  const invoices = await prisma.invoice.findMany({
    where: {
      type: 'INVOICE',
      status: { in: [...OPEN_STATUSES, 'PAID'] },
      ...(companyId ? { companyId } : {}),
    },
    select: { status: true, total: true, amountPaid: true, dueDate: true },
  });
  const normalized = invoices.map((i) => ({
    status: i.status,
    total: toNumber(i.total),
    amountPaid: toNumber(i.amountPaid),
    dueDate: i.dueDate,
  }));

  return {
    summary: summarizeInvoicesForAR(normalized, now),
    aging: computeARAgingBuckets(normalized, now),
  };
}
