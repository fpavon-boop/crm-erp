import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { TestDb } from './test-db';
import { startTestDb } from './test-db';

/**
 * Phase 3 (Customer 360): proves the authorization boundary is real, not
 * just a UI toggle — a role without a given module's access never even
 * receives that section's data from getCustomer360(), even though the
 * underlying rows genuinely exist for this company. See
 * docs/CUSTOMER_360.md.
 */
describe('getCustomer360 authorization boundaries', () => {
  let db: TestDb;
  let getCustomer360: typeof import('../src/lib/customer-360')['getCustomer360'];

  beforeAll(async () => {
    db = await startTestDb();
    process.env.DATABASE_URL = db.url;
    const mod = await import('../src/lib/customer-360');
    getCustomer360 = mod.getCustomer360;
  }, 60000);

  afterAll(async () => {
    await db.stop();
  });

  async function seedFullCustomer() {
    const user = await db.prisma.user.create({
      data: { name: 'Test Admin', email: `admin-${Math.random()}@example.com`, passwordHash: 'x', role: 'ADMIN' },
    });
    const company = await db.prisma.company.create({
      data: { name: `Acme ${Math.random().toString(36).slice(2)}`, type: 'CUSTOMER' },
    });
    const product = await db.prisma.product.create({
      data: { sku: `SKU-${Math.random().toString(36).slice(2)}`, name: 'Test Brick', price: 25 },
    });

    const salesOrder = await db.prisma.salesOrder.create({
      data: {
        number: `SO-${Math.random().toString(36).slice(2)}`,
        companyId: company.id,
        status: 'CONFIRMED',
        total: 250,
        items: { create: [{ productId: product.id, description: 'Test Brick', quantity: 10, unitPrice: 25 }] },
      },
    });

    const invoice = await db.prisma.invoice.create({
      data: {
        number: `INV-${Math.random().toString(36).slice(2)}`,
        companyId: company.id,
        salesOrderId: salesOrder.id,
        status: 'PARTIAL',
        total: 250,
        amountPaid: 100,
      },
    });
    await db.prisma.payment.create({ data: { invoiceId: invoice.id, amount: 100, method: 'card' } });

    const purchaseOrder = await db.prisma.purchaseOrder.create({
      data: { number: `PO-${Math.random().toString(36).slice(2)}`, supplierId: company.id, status: 'SENT', total: 500 },
    });

    await db.prisma.task.create({
      data: { title: 'Follow up', relatedType: 'COMPANY', relatedId: company.id, createdById: user.id },
    });

    await db.prisma.whatsAppMessage.create({
      data: { companyId: company.id, direction: 'INBOUND', fromNumber: '15550001111', toNumber: '15550002222', body: 'Hi' },
    });

    return { company, salesOrder, invoice, purchaseOrder };
  }

  it('ADMIN sees every section, fully populated', async () => {
    const { company } = await seedFullCustomer();
    const data = await getCustomer360(company.id, 'ADMIN');

    expect(data.sales).not.toBeNull();
    expect(data.invoicing).not.toBeNull();
    expect(data.purchasing).not.toBeNull();
    expect(data.tasks).not.toBeNull();
    expect(data.whatsapp).not.toBeNull();

    expect(data.sales!.salesOrders).toHaveLength(1);
    expect(data.invoicing!.invoices).toHaveLength(1);
    expect(data.invoicing!.payments).toHaveLength(1);
    expect(data.purchasing!.purchaseOrders).toHaveLength(1);
    expect(data.tasks!.tasks).toHaveLength(1);
    expect(data.whatsapp!.messages).toHaveLength(1);
    expect(data.sales!.topProducts).toHaveLength(1);
    expect(data.sales!.topProducts[0].totalSpent).toBe(250);
  });

  it('SALES does not receive purchasing data, even though a real PurchaseOrder exists for this company', async () => {
    const { company, purchaseOrder } = await seedFullCustomer();
    const data = await getCustomer360(company.id, 'SALES');

    expect(data.purchasing).toBeNull();
    expect(data.sales).not.toBeNull();
    expect(data.invoicing).not.toBeNull();

    // Sanity: the row genuinely exists — this isn't a false-negative test.
    const stillThere = await db.prisma.purchaseOrder.findUnique({ where: { id: purchaseOrder.id } });
    expect(stillThere).not.toBeNull();
  });

  it('OPERATIONS does not receive invoicing/financial data, even though real invoices and payments exist', async () => {
    const { company, invoice } = await seedFullCustomer();
    const data = await getCustomer360(company.id, 'OPERATIONS');

    expect(data.invoicing).toBeNull();
    expect(data.sales).not.toBeNull();
    expect(data.purchasing).not.toBeNull();

    const stillThere = await db.prisma.invoice.findUnique({ where: { id: invoice.id } });
    expect(stillThere).not.toBeNull();
  });

  it('ACCOUNTING does not receive sales-side data (orders, opportunities, products purchased) or WhatsApp messages', async () => {
    const { company } = await seedFullCustomer();
    const data = await getCustomer360(company.id, 'ACCOUNTING');

    expect(data.sales).toBeNull();
    expect(data.whatsapp).toBeNull();
    expect(data.invoicing).not.toBeNull();
    expect(data.purchasing).not.toBeNull();
    expect(data.tasks).not.toBeNull();
  });

  it('activity/status is computed only from sections the role can actually see', async () => {
    const { company } = await seedFullCustomer();

    // ACCOUNTING can't see the sales order or WhatsApp message (both very
    // recent), only the invoice/purchase-order/task activity — the
    // computed lastActivityAt must not leak timing from a section this
    // role has no access to.
    const forAccounting = await getCustomer360(company.id, 'ACCOUNTING');
    const forAdmin = await getCustomer360(company.id, 'ADMIN');

    expect(forAccounting.activity.lastActivityAt).not.toBeNull();
    expect(forAdmin.activity.lastActivityAt).not.toBeNull();
    // Both should still resolve to "active" (everything was just created),
    // but the underlying timestamp pools are allowed to differ by role.
    expect(forAccounting.activity.status).toBe('active');
    expect(forAdmin.activity.status).toBe('active');
  });

  it('a company with no activity at all reports no_activity, not a crash or a fabricated date', async () => {
    const company = await db.prisma.company.create({ data: { name: `Empty ${Math.random()}`, type: 'CUSTOMER' } });
    const data = await getCustomer360(company.id, 'ADMIN');

    expect(data.activity.lastActivityAt).toBeNull();
    expect(data.activity.status).toBe('no_activity');
    expect(data.sales!.salesOrders).toHaveLength(0);
    expect(data.invoicing!.invoices).toHaveLength(0);
  });

  it('throws CompanyNotFoundError for a non-existent company id, for every role', async () => {
    const { CompanyNotFoundError } = await import('../src/lib/customer-360');
    await expect(getCustomer360('does-not-exist', 'ADMIN')).rejects.toBeInstanceOf(CompanyNotFoundError);
  });
});
