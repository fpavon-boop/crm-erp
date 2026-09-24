import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { TestDb } from './test-db';
import { startTestDb } from './test-db';
import { canAccess } from '../src/lib/permissions';

/**
 * Phase 5 (Accounts Receivable): proves two things the calculation unit
 * tests can't —
 *
 * 1. getAccountsReceivableDashboard() reads from real Invoice rows (not a
 *    fixture), types-only INVOICE (not ESTIMATE/RECEIPT), and its summary
 *    and aging views agree with each other because both come from the same
 *    query.
 * 2. The AR dashboard's authorization boundary (gated via
 *    requireModule('finance') at the page level) matches the user's own
 *    "Accounting/Admin access" requirement: only ADMIN and ACCOUNTING can
 *    reach the `finance` module; SALES and OPERATIONS cannot.
 */
describe('Accounts Receivable dashboard', () => {
  let db: TestDb;
  let getAccountsReceivableDashboard: typeof import('../src/lib/accounts-receivable')['getAccountsReceivableDashboard'];

  beforeAll(async () => {
    db = await startTestDb();
    process.env.DATABASE_URL = db.url;
    const mod = await import('../src/lib/accounts-receivable');
    getAccountsReceivableDashboard = mod.getAccountsReceivableDashboard;
  }, 60000);

  afterAll(async () => {
    await db.stop();
  });

  function invoiceNumber() {
    return `INV-${Math.random().toString(36).slice(2)}`;
  }

  it('role-based access: only ADMIN and ACCOUNTING can reach the finance module the AR dashboard is gated behind', () => {
    expect(canAccess('ADMIN', 'finance')).toBe(true);
    expect(canAccess('ACCOUNTING', 'finance')).toBe(true);
    expect(canAccess('SALES', 'finance')).toBe(false);
    expect(canAccess('OPERATIONS', 'finance')).toBe(false);
  });

  it('aggregates real Invoice rows into matching summary and aging views', async () => {
    const now = new Date();
    const overdueDate = new Date(now.getTime() - 45 * 86_400_000);
    const futureDate = new Date(now.getTime() + 30 * 86_400_000);

    await db.prisma.invoice.create({
      data: { number: invoiceNumber(), type: 'INVOICE', status: 'SENT', total: 100, amountPaid: 0, dueDate: futureDate },
    });
    await db.prisma.invoice.create({
      data: { number: invoiceNumber(), type: 'INVOICE', status: 'SENT', total: 200, amountPaid: 0, dueDate: overdueDate },
    });
    await db.prisma.invoice.create({
      data: { number: invoiceNumber(), type: 'INVOICE', status: 'PAID', total: 300, amountPaid: 300, dueDate: overdueDate },
    });
    // DRAFT must never appear in AR at all.
    await db.prisma.invoice.create({
      data: { number: invoiceNumber(), type: 'INVOICE', status: 'DRAFT', total: 999, amountPaid: 0, dueDate: overdueDate },
    });
    // A non-INVOICE type (ESTIMATE) must never be counted as receivable.
    await db.prisma.invoice.create({
      data: { number: invoiceNumber(), type: 'ESTIMATE', status: 'SENT', total: 777, amountPaid: 0, dueDate: overdueDate },
    });

    const { summary, aging } = await getAccountsReceivableDashboard(now);

    expect(summary.current).toBe(100);
    expect(summary.overdue).toBe(200);
    expect(summary.totalOutstanding).toBe(300);
    expect(summary.paid).toBe(300);

    // The aging view and the summary's "overdue" figure must agree — both
    // are derived from the exact same fetched rows.
    expect(aging.total).toBe(summary.overdue);
    expect(aging.d31to60).toBe(200);
  });

  it('a payment recorded against an invoice reduces its AR balance and can move it out of overdue', async () => {
    const overdueDate = new Date(Date.now() - 10 * 86_400_000);
    const invoice = await db.prisma.invoice.create({
      data: { number: invoiceNumber(), type: 'INVOICE', status: 'SENT', total: 150, amountPaid: 0, dueDate: overdueDate },
    });

    const before = await getAccountsReceivableDashboard();
    const beforeOverdue = before.summary.overdue;

    await db.prisma.payment.create({ data: { invoiceId: invoice.id, amount: 150, method: 'card' } });
    await db.prisma.invoice.update({ where: { id: invoice.id }, data: { amountPaid: 150, status: 'PAID' } });

    const after = await getAccountsReceivableDashboard();
    expect(after.summary.overdue).toBe(beforeOverdue - 150);
  });
});
