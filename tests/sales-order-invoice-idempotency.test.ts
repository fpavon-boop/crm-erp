import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { TestDb } from './test-db';
import { startTestDb } from './test-db';

/** Item 4 (Phase 0): creating an invoice from a sales order must be
 * idempotent — repeat calls (a double-click, a retried request) return the
 * same invoice instead of creating a second (third, fourth...) one. This is
 * C2 in docs/SYSTEM_AUDIT.md. */
describe('Idempotent sales-order invoice creation', () => {
  let db: TestDb;
  let createInvoiceForSalesOrder: typeof import('../src/lib/sales-orders')['createInvoiceForSalesOrder'];
  let SalesOrderNotFoundError: typeof import('../src/lib/sales-orders')['SalesOrderNotFoundError'];
  let userId: string;

  beforeAll(async () => {
    db = await startTestDb();
    process.env.DATABASE_URL = db.url;
    const mod = await import('../src/lib/sales-orders');
    createInvoiceForSalesOrder = mod.createInvoiceForSalesOrder;
    SalesOrderNotFoundError = mod.SalesOrderNotFoundError;

    const user = await db.prisma.user.create({
      data: { name: 'Test User', email: `test-${Math.random()}@example.com`, passwordHash: 'x', role: 'SALES' },
    });
    userId = user.id;
  }, 60000);

  afterAll(async () => {
    await db.stop();
  });

  async function seedOrder() {
    return db.prisma.salesOrder.create({
      data: {
        number: `SO-INV-${Math.random().toString(36).slice(2)}`,
        status: 'CONFIRMED',
        subtotal: 100,
        total: 100,
        items: { create: [{ description: 'Test item', quantity: 2, unitPrice: 50 }] },
      },
    });
  }

  it('creates an invoice the first time', async () => {
    const order = await seedOrder();
    const result = await createInvoiceForSalesOrder(order.id, userId);
    expect(result.created).toBe(true);
    expect(result.invoice.salesOrderId).toBe(order.id);
    expect(Number(result.invoice.total)).toBe(100);
    expect(result.invoice.items).toHaveLength(1);
  });

  it('a second call returns the SAME invoice instead of creating another one', async () => {
    const order = await seedOrder();
    const first = await createInvoiceForSalesOrder(order.id, userId);
    const second = await createInvoiceForSalesOrder(order.id, userId);

    expect(second.created).toBe(false);
    expect(second.invoice.id).toBe(first.invoice.id);

    const invoicesForOrder = await db.prisma.invoice.findMany({ where: { salesOrderId: order.id } });
    expect(invoicesForOrder).toHaveLength(1);
  });

  it('throws a clear error for a sales order that does not exist', async () => {
    await expect(createInvoiceForSalesOrder('does-not-exist', userId)).rejects.toBeInstanceOf(SalesOrderNotFoundError);
  });

  it('THE FIX: two concurrent create-invoice requests for the same order never create two invoices', async () => {
    const order = await seedOrder();

    const results = await Promise.all([
      createInvoiceForSalesOrder(order.id, userId),
      createInvoiceForSalesOrder(order.id, userId),
    ]);

    // Exactly one of the two calls actually created the invoice; the other
    // was handed back the same one.
    const createdCount = results.filter((r) => r.created).length;
    expect(createdCount).toBe(1);
    expect(results[0].invoice.id).toBe(results[1].invoice.id);

    const invoicesForOrder = await db.prisma.invoice.findMany({ where: { salesOrderId: order.id } });
    expect(invoicesForOrder).toHaveLength(1);
  });

  it('different orders are unaffected by the per-order lock and can be invoiced in parallel', async () => {
    const [orderA, orderB] = await Promise.all([seedOrder(), seedOrder()]);
    const [resultA, resultB] = await Promise.all([
      createInvoiceForSalesOrder(orderA.id, userId),
      createInvoiceForSalesOrder(orderB.id, userId),
    ]);
    expect(resultA.created).toBe(true);
    expect(resultB.created).toBe(true);
    expect(resultA.invoice.id).not.toBe(resultB.invoice.id);
  });
});
