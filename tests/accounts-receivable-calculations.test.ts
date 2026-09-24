import { describe, it, expect } from 'vitest';
import {
  deriveInvoiceStatus,
  computeBalanceDue,
  verifyInvoiceFinancials,
  summarizeInvoicesForAR,
  computeARAgingBuckets,
} from '../src/lib/accounts-receivable';

const DAY = 86_400_000;

/**
 * Phase 5 (Accounts Receivable): pure-function tests for status derivation,
 * balance-due math, financial-consistency verification, AR summary
 * aggregation, and aging-bucket boundaries. No database needed — these are
 * plain computations over already-fetched Invoice-shaped rows, matching
 * requirement #4 ("balance due/payment reconciliation logic; status
 * transitions; aging bucket calculations and boundary date conditions").
 */
describe('deriveInvoiceStatus', () => {
  const now = new Date('2026-06-15T00:00:00Z');

  it('SENT with no payment and a future due date stays SENT', () => {
    const status = deriveInvoiceStatus(
      { status: 'SENT', total: 100, amountPaid: 0, dueDate: new Date('2026-07-01') },
      now
    );
    expect(status).toBe('SENT');
  });

  it('SENT with a partial payment becomes PARTIAL', () => {
    const status = deriveInvoiceStatus(
      { status: 'SENT', total: 100, amountPaid: 40, dueDate: new Date('2026-07-01') },
      now
    );
    expect(status).toBe('PARTIAL');
  });

  it('PARTIAL fully paid becomes PAID', () => {
    const status = deriveInvoiceStatus(
      { status: 'PARTIAL', total: 100, amountPaid: 100, dueDate: new Date('2026-07-01') },
      now
    );
    expect(status).toBe('PAID');
  });

  it('SENT past its due date and unpaid becomes OVERDUE', () => {
    const status = deriveInvoiceStatus(
      { status: 'SENT', total: 100, amountPaid: 0, dueDate: new Date('2026-06-01') },
      now
    );
    expect(status).toBe('OVERDUE');
  });

  it('PARTIAL past its due date becomes OVERDUE (not left as PARTIAL)', () => {
    const status = deriveInvoiceStatus(
      { status: 'PARTIAL', total: 100, amountPaid: 40, dueDate: new Date('2026-06-01') },
      now
    );
    expect(status).toBe('OVERDUE');
  });

  it('a payment that fully covers an already-OVERDUE invoice moves it to PAID, not left OVERDUE', () => {
    const status = deriveInvoiceStatus(
      { status: 'OVERDUE', total: 100, amountPaid: 100, dueDate: new Date('2026-06-01') },
      now
    );
    expect(status).toBe('PAID');
  });

  it('a partial payment on an already-OVERDUE invoice keeps it OVERDUE, not PARTIAL', () => {
    const status = deriveInvoiceStatus(
      { status: 'OVERDUE', total: 100, amountPaid: 40, dueDate: new Date('2026-06-01') },
      now
    );
    expect(status).toBe('OVERDUE');
  });

  it('no due date at all never becomes OVERDUE', () => {
    const status = deriveInvoiceStatus({ status: 'SENT', total: 100, amountPaid: 0, dueDate: null }, now);
    expect(status).toBe('SENT');
  });

  it('DRAFT is never overridden, even past due and unpaid', () => {
    const status = deriveInvoiceStatus(
      { status: 'DRAFT', total: 100, amountPaid: 0, dueDate: new Date('2020-01-01') },
      now
    );
    expect(status).toBe('DRAFT');
  });

  it('CANCELLED is never overridden, even if fully paid', () => {
    const status = deriveInvoiceStatus(
      { status: 'CANCELLED', total: 100, amountPaid: 100, dueDate: new Date('2020-01-01') },
      now
    );
    expect(status).toBe('CANCELLED');
  });

  it('a zero-total invoice is treated as PAID', () => {
    const status = deriveInvoiceStatus({ status: 'SENT', total: 0, amountPaid: 0, dueDate: null }, now);
    expect(status).toBe('PAID');
  });

  it('an overpaid invoice is PAID, not a distinct overpaid state', () => {
    const status = deriveInvoiceStatus(
      { status: 'PARTIAL', total: 100, amountPaid: 150, dueDate: new Date('2026-07-01') },
      now
    );
    expect(status).toBe('PAID');
  });

  it('due exactly at "now" is not yet overdue', () => {
    const status = deriveInvoiceStatus({ status: 'SENT', total: 100, amountPaid: 0, dueDate: now }, now);
    expect(status).toBe('SENT');
  });
});

describe('computeBalanceDue', () => {
  it('total minus amountPaid', () => {
    expect(computeBalanceDue(100, 40)).toBe(60);
  });

  it('never negative for an overpaid invoice', () => {
    expect(computeBalanceDue(100, 150)).toBe(0);
  });

  it('rounds to two decimal places', () => {
    expect(computeBalanceDue(10.005, 0)).toBeCloseTo(10.01, 2);
  });
});

describe('verifyInvoiceFinancials', () => {
  const items = [{ quantity: 2, unitPrice: 50, taxRate: 10, discount: 5 }];
  // subtotal 100, taxTotal 10, discountTotal 5, total 105

  it('reports consistent when stored totals and status match the derived values', () => {
    const result = verifyInvoiceFinancials(
      { status: 'SENT', subtotal: 100, taxTotal: 10, discountTotal: 5, total: 105, amountPaid: 0, dueDate: null },
      items
    );
    expect(result.consistent).toBe(true);
    expect(result.discrepancies).toHaveLength(0);
    expect(result.balanceDue).toBe(105);
  });

  it('flags a stored total that drifted from the line items', () => {
    const result = verifyInvoiceFinancials(
      { status: 'SENT', subtotal: 100, taxTotal: 10, discountTotal: 5, total: 999, amountPaid: 0, dueDate: null },
      items
    );
    expect(result.consistent).toBe(false);
    expect(result.discrepancies.some((d) => d.field === 'total')).toBe(true);
  });

  it('flags a stale stored status that no longer matches the derived one', () => {
    const result = verifyInvoiceFinancials(
      { status: 'SENT', subtotal: 100, taxTotal: 10, discountTotal: 5, total: 105, amountPaid: 105, dueDate: null },
      items
    );
    expect(result.consistent).toBe(false);
    const statusDiscrepancy = result.discrepancies.find((d) => d.field === 'status');
    expect(statusDiscrepancy?.expected).toBe('PAID');
  });

  it('tolerates a sub-cent rounding difference', () => {
    const result = verifyInvoiceFinancials(
      { status: 'SENT', subtotal: 100.001, taxTotal: 10, discountTotal: 5, total: 105.001, amountPaid: 0, dueDate: null },
      items
    );
    expect(result.consistent).toBe(true);
  });
});

describe('summarizeInvoicesForAR', () => {
  const now = new Date('2026-06-15T00:00:00Z');

  it('excludes DRAFT and CANCELLED entirely', () => {
    const summary = summarizeInvoicesForAR(
      [
        { status: 'DRAFT', total: 500, amountPaid: 0, dueDate: null },
        { status: 'CANCELLED', total: 900, amountPaid: 0, dueDate: null },
      ],
      now
    );
    expect(summary.totalOutstanding).toBe(0);
    expect(summary.totalOutstandingCount).toBe(0);
  });

  it('splits open invoices into current vs overdue by due date, not stored status', () => {
    const summary = summarizeInvoicesForAR(
      [
        { status: 'SENT', total: 100, amountPaid: 0, dueDate: new Date('2026-07-01') }, // current
        { status: 'SENT', total: 50, amountPaid: 0, dueDate: new Date('2026-06-01') }, // stale status, actually overdue
      ],
      now
    );
    expect(summary.current).toBe(100);
    expect(summary.currentCount).toBe(1);
    expect(summary.overdue).toBe(50);
    expect(summary.overdueCount).toBe(1);
    expect(summary.totalOutstanding).toBe(150);
    expect(summary.totalOutstandingCount).toBe(2);
  });

  it('current + overdue always equals totalOutstanding', () => {
    const summary = summarizeInvoicesForAR(
      [
        { status: 'SENT', total: 100, amountPaid: 0, dueDate: new Date('2026-07-01') },
        { status: 'OVERDUE', total: 50, amountPaid: 0, dueDate: new Date('2026-05-01') },
        { status: 'PARTIAL', total: 80, amountPaid: 20, dueDate: null },
      ],
      now
    );
    expect(summary.current + summary.overdue).toBe(summary.totalOutstanding);
  });

  it('partiallyPaid tracks invoices with a nonzero payment, separate from the current/overdue split', () => {
    const summary = summarizeInvoicesForAR(
      [{ status: 'PARTIAL', total: 100, amountPaid: 30, dueDate: new Date('2026-07-01') }],
      now
    );
    expect(summary.partiallyPaid).toBe(70);
    expect(summary.partiallyPaidCount).toBe(1);
  });

  it('PAID invoices contribute to paid but not totalOutstanding', () => {
    const summary = summarizeInvoicesForAR([{ status: 'PAID', total: 100, amountPaid: 100, dueDate: null }], now);
    expect(summary.paid).toBe(100);
    expect(summary.paidCount).toBe(1);
    expect(summary.totalOutstanding).toBe(0);
  });
});

describe('computeARAgingBuckets', () => {
  const now = new Date('2026-06-15T00:00:00Z');

  function daysAgo(days: number): Date {
    return new Date(now.getTime() - days * DAY);
  }

  it('a not-yet-due invoice contributes to no bucket', () => {
    const buckets = computeARAgingBuckets(
      [{ status: 'SENT', total: 100, amountPaid: 0, dueDate: new Date('2026-07-01') }],
      now
    );
    expect(buckets.total).toBe(0);
    expect(buckets.count).toBe(0);
  });

  it('exactly 30 days late falls in the 0-30 bucket', () => {
    const buckets = computeARAgingBuckets([{ status: 'SENT', total: 100, amountPaid: 0, dueDate: daysAgo(30) }], now);
    expect(buckets.d0to30).toBe(100);
    expect(buckets.d31to60).toBe(0);
  });

  it('exactly 31 days late falls in the 31-60 bucket, not 0-30', () => {
    const buckets = computeARAgingBuckets([{ status: 'SENT', total: 100, amountPaid: 0, dueDate: daysAgo(31) }], now);
    expect(buckets.d0to30).toBe(0);
    expect(buckets.d31to60).toBe(100);
  });

  it('exactly 60 days late falls in the 31-60 bucket', () => {
    const buckets = computeARAgingBuckets([{ status: 'SENT', total: 100, amountPaid: 0, dueDate: daysAgo(60) }], now);
    expect(buckets.d31to60).toBe(100);
    expect(buckets.d61to90).toBe(0);
  });

  it('exactly 61 days late falls in the 61-90 bucket, not 31-60', () => {
    const buckets = computeARAgingBuckets([{ status: 'SENT', total: 100, amountPaid: 0, dueDate: daysAgo(61) }], now);
    expect(buckets.d31to60).toBe(0);
    expect(buckets.d61to90).toBe(100);
  });

  it('exactly 90 days late falls in the 61-90 bucket', () => {
    const buckets = computeARAgingBuckets([{ status: 'SENT', total: 100, amountPaid: 0, dueDate: daysAgo(90) }], now);
    expect(buckets.d61to90).toBe(100);
    expect(buckets.d90plus).toBe(0);
  });

  it('exactly 91 days late falls in the 90+ bucket', () => {
    const buckets = computeARAgingBuckets([{ status: 'SENT', total: 100, amountPaid: 0, dueDate: daysAgo(91) }], now);
    expect(buckets.d61to90).toBe(0);
    expect(buckets.d90plus).toBe(100);
  });

  it('a fully-paid overdue invoice (zero balance) is excluded from aging entirely', () => {
    const buckets = computeARAgingBuckets(
      [{ status: 'PARTIAL', total: 100, amountPaid: 100, dueDate: daysAgo(45) }],
      now
    );
    expect(buckets.total).toBe(0);
    expect(buckets.count).toBe(0);
  });

  it('a partially-paid overdue invoice ages by its remaining balance, not its original total', () => {
    const buckets = computeARAgingBuckets(
      [{ status: 'PARTIAL', total: 100, amountPaid: 60, dueDate: daysAgo(45) }],
      now
    );
    expect(buckets.d31to60).toBe(40);
    expect(buckets.total).toBe(40);
  });

  it('DRAFT/CANCELLED invoices never age, even with a long-past due date', () => {
    const buckets = computeARAgingBuckets(
      [
        { status: 'DRAFT', total: 100, amountPaid: 0, dueDate: daysAgo(200) },
        { status: 'CANCELLED', total: 100, amountPaid: 0, dueDate: daysAgo(200) },
      ],
      now
    );
    expect(buckets.count).toBe(0);
  });

  it('sums multiple overdue invoices across buckets, with total matching their combined balance', () => {
    const buckets = computeARAgingBuckets(
      [
        { status: 'SENT', total: 100, amountPaid: 0, dueDate: daysAgo(10) },
        { status: 'SENT', total: 200, amountPaid: 0, dueDate: daysAgo(45) },
        { status: 'SENT', total: 300, amountPaid: 0, dueDate: daysAgo(120) },
      ],
      now
    );
    expect(buckets.d0to30).toBe(100);
    expect(buckets.d31to60).toBe(200);
    expect(buckets.d90plus).toBe(300);
    expect(buckets.total).toBe(600);
    expect(buckets.count).toBe(3);
  });
});
