import { describe, it, expect } from 'vitest';
import { computeCustomerFinancialSummary, getCustomer360Sections } from '../src/lib/customer-360';

/**
 * Phase 3 (Customer 360): pure-function tests for the financial
 * aggregation and role-visibility logic. No database needed — these are
 * plain computations over already-fetched rows / a role enum, matching
 * requirement #4 ("financial aggregations and summary calculations").
 */
describe('computeCustomerFinancialSummary', () => {
  it('sums totalSales/totalPaid across SENT/PARTIAL/PAID/OVERDUE invoices', () => {
    const summary = computeCustomerFinancialSummary([
      { status: 'SENT', total: 100, amountPaid: 0 },
      { status: 'PARTIAL', total: 200, amountPaid: 50 },
      { status: 'PAID', total: 300, amountPaid: 300 },
      { status: 'OVERDUE', total: 150, amountPaid: 0 },
    ]);
    expect(summary.totalSales).toBe(750);
    expect(summary.totalPaid).toBe(350);
    expect(summary.invoiceCount).toBe(4);
  });

  it('excludes DRAFT invoices (not yet issued) from every figure', () => {
    const summary = computeCustomerFinancialSummary([
      { status: 'DRAFT', total: 500, amountPaid: 0 },
      { status: 'SENT', total: 100, amountPaid: 0 },
    ]);
    expect(summary.totalSales).toBe(100);
    expect(summary.invoiceCount).toBe(1);
  });

  it('excludes CANCELLED invoices (never actually billed) from every figure', () => {
    const summary = computeCustomerFinancialSummary([
      { status: 'CANCELLED', total: 900, amountPaid: 0 },
      { status: 'PAID', total: 100, amountPaid: 100 },
    ]);
    expect(summary.totalSales).toBe(100);
    expect(summary.totalPaid).toBe(100);
    expect(summary.totalOutstanding).toBe(0);
    expect(summary.invoiceCount).toBe(1);
  });

  it('totalOutstanding only counts SENT/PARTIAL/OVERDUE, never PAID (even though PAID counts toward totalSales)', () => {
    const summary = computeCustomerFinancialSummary([
      { status: 'PAID', total: 1000, amountPaid: 1000 },
      { status: 'PARTIAL', total: 400, amountPaid: 150 },
    ]);
    expect(summary.totalSales).toBe(1400);
    expect(summary.totalOutstanding).toBe(250); // only the 400-150 partial invoice
  });

  it('handles Prisma Decimal-like values (toNumber()) the same as plain numbers', () => {
    const decimalLike = { toNumber: () => 250 };
    const summary = computeCustomerFinancialSummary([{ status: 'SENT', total: decimalLike, amountPaid: 0 }]);
    expect(summary.totalSales).toBe(250);
  });

  it('an empty invoice list produces all-zero, not NaN or undefined', () => {
    const summary = computeCustomerFinancialSummary([]);
    expect(summary).toEqual({ totalSales: 0, totalOutstanding: 0, totalPaid: 0, invoiceCount: 0 });
  });

  it('an invoice paid in full has zero outstanding, not a negative or leftover balance', () => {
    const summary = computeCustomerFinancialSummary([{ status: 'PAID', total: 500, amountPaid: 500 }]);
    expect(summary.totalOutstanding).toBe(0);
  });
});

describe('getCustomer360Sections (role -> visible sections)', () => {
  it('ADMIN sees every section', () => {
    expect(getCustomer360Sections('ADMIN')).toEqual({
      sales: true,
      invoicing: true,
      purchasing: true,
      tasks: true,
      whatsapp: true,
      inbox: true,
    });
  });

  it('SALES sees sales/invoicing/tasks/whatsapp/inbox but NOT purchasing', () => {
    const sections = getCustomer360Sections('SALES');
    expect(sections.sales).toBe(true);
    expect(sections.invoicing).toBe(true);
    expect(sections.purchasing).toBe(false);
    expect(sections.tasks).toBe(true);
    expect(sections.whatsapp).toBe(true);
    expect(sections.inbox).toBe(true);
  });

  it('OPERATIONS sees sales/purchasing/tasks/whatsapp/inbox but NOT invoicing', () => {
    const sections = getCustomer360Sections('OPERATIONS');
    expect(sections.sales).toBe(true);
    expect(sections.invoicing).toBe(false);
    expect(sections.purchasing).toBe(true);
    expect(sections.tasks).toBe(true);
    expect(sections.whatsapp).toBe(true);
    expect(sections.inbox).toBe(true);
  });

  it('ACCOUNTING sees invoicing/purchasing/tasks but NOT sales/whatsapp/inbox', () => {
    const sections = getCustomer360Sections('ACCOUNTING');
    expect(sections.sales).toBe(false);
    expect(sections.invoicing).toBe(true);
    expect(sections.purchasing).toBe(true);
    expect(sections.tasks).toBe(true);
    expect(sections.whatsapp).toBe(false);
    expect(sections.inbox).toBe(true);
  });
});
