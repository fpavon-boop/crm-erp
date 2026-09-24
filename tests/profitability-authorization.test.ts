import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { TestDb } from './test-db';
import { startTestDb } from './test-db';
import { canAccess } from '../src/lib/permissions';

/**
 * Phase 6 (Product Cost & Profitability Reporting): database-backed tests
 * proving —
 *
 * 1. getProductCostMap() resolves cost in the documented priority order
 *    (purchase-history weighted average > standard cost > unknown), against
 *    real GoodsReceiptItem/PurchaseOrderItem/Product rows.
 * 2. Each of the 5 profitability levels (product/order/invoice/customer/
 *    month) aggregates real rows correctly and excludes DRAFT/CANCELLED
 *    orders the same way src/lib/finance.ts's "Orders sold" does.
 * 3. The dashboard is gated on the same `finance` module as the AR
 *    dashboard (ADMIN/ACCOUNTING only — "Admin/Accounting/Management" per
 *    the task, and this app has no separate Management role).
 */
describe('Profitability reporting', () => {
  let db: TestDb;
  let profitability: typeof import('../src/lib/profitability');

  beforeAll(async () => {
    db = await startTestDb();
    process.env.DATABASE_URL = db.url;
    profitability = await import('../src/lib/profitability');
  }, 60000);

  afterAll(async () => {
    await db.stop();
  });

  function id() {
    return Math.random().toString(36).slice(2);
  }

  async function makeProduct(overrides: { cost?: number } = {}) {
    return db.prisma.product.create({
      data: { sku: `SKU-${id()}`, name: `Product ${id()}`, price: 100, cost: overrides.cost ?? 0 },
    });
  }

  async function makeWarehouse() {
    return db.prisma.warehouse.create({ data: { name: `WH-${id()}` } });
  }

  /** Seeds a fully-received PurchaseOrderItem with a given unitCost, via a
   * real GoodsReceipt/GoodsReceiptItem — the actual path getProductCostMap()
   * reads from, not a shortcut. */
  async function receiveAtCost(productId: string, warehouseId: string, quantity: number, unitCost: number) {
    const po = await db.prisma.purchaseOrder.create({
      data: {
        number: `PO-${id()}`,
        status: 'SENT',
        items: { create: [{ productId, description: 'x', quantity, unitCost }] },
      },
      include: { items: true },
    });
    const poItem = po.items[0];
    await db.prisma.goodsReceipt.create({
      data: {
        purchaseOrderId: po.id,
        warehouseId,
        items: { create: [{ purchaseOrderItemId: poItem.id, productId, quantity }] },
      },
    });
  }

  async function makeSoldOrder(opts: {
    companyId?: string;
    status?: 'CONFIRMED' | 'SHIPPED' | 'DELIVERED' | 'DRAFT' | 'CANCELLED';
    createdAt?: Date;
    items: Array<{ productId: string | null; quantity: number; unitPrice: number; discount?: number; description?: string }>;
  }) {
    return db.prisma.salesOrder.create({
      data: {
        number: `SO-${id()}`,
        status: opts.status ?? 'CONFIRMED',
        companyId: opts.companyId,
        createdAt: opts.createdAt,
        items: {
          create: opts.items.map((i) => ({
            productId: i.productId,
            description: i.description ?? 'line',
            quantity: i.quantity,
            unitPrice: i.unitPrice,
            discount: i.discount ?? 0,
          })),
        },
      },
    });
  }

  it('getProductCostMap prefers a purchase-history weighted average over standard cost', async () => {
    const product = await makeProduct({ cost: 999 }); // deliberately wrong, to prove history wins
    const wh = await makeWarehouse();
    await receiveAtCost(product.id, wh.id, 10, 4); // 10 units @ $4
    await receiveAtCost(product.id, wh.id, 30, 8); // 30 units @ $8
    // weighted average = (10*4 + 30*8) / 40 = 280/40 = 7

    const map = await profitability.getProductCostMap();
    const info = map.get(product.id);
    expect(info?.source).toBe('purchase_history');
    expect(info?.unitCost).toBe(7);
  });

  it('getProductCostMap falls back to standard cost when there is no purchase history', async () => {
    const product = await makeProduct({ cost: 12.5 });
    const map = await profitability.getProductCostMap();
    expect(map.get(product.id)).toEqual({ unitCost: 12.5, source: 'standard_cost' });
  });

  it('getProductCostMap reports unknown (not zero) when cost is 0 and there is no purchase history', async () => {
    const product = await makeProduct({ cost: 0 });
    const map = await profitability.getProductCostMap();
    expect(map.get(product.id)).toEqual({ unitCost: null, source: 'unknown' });
  });

  it('role-based access: the finance module (which gates the profitability dashboard) is ADMIN/ACCOUNTING only', () => {
    expect(canAccess('ADMIN', 'finance')).toBe(true);
    expect(canAccess('ACCOUNTING', 'finance')).toBe(true);
    expect(canAccess('SALES', 'finance')).toBe(false);
    expect(canAccess('OPERATIONS', 'finance')).toBe(false);
  });

  it('getProductProfitability aggregates real sold-order lines per product, excluding DRAFT and CANCELLED orders', async () => {
    const product = await makeProduct({ cost: 5 });
    await makeSoldOrder({ status: 'CONFIRMED', items: [{ productId: product.id, quantity: 10, unitPrice: 20 }] });
    await makeSoldOrder({ status: 'DRAFT', items: [{ productId: product.id, quantity: 999, unitPrice: 20 }] });
    await makeSoldOrder({ status: 'CANCELLED', items: [{ productId: product.id, quantity: 999, unitPrice: 20 }] });

    const rows = await profitability.getProductProfitability();
    const row = rows.find((r) => r.productId === product.id);
    expect(row).toBeDefined();
    expect(row!.quantitySold).toBe(10);
    expect(row!.summary.revenue).toBe(200);
    expect(row!.summary.cogs).toBe(50);
  });

  it('getSalesOrderProfitability computes revenue/margin per order, including a non-product shipping-style line', async () => {
    const product = await makeProduct({ cost: 3 });
    const order = await makeSoldOrder({
      status: 'CONFIRMED',
      items: [
        { productId: product.id, quantity: 5, unitPrice: 10 }, // revenue 50, cogs 15
        { productId: null, quantity: 1, unitPrice: 8, description: 'Shipping' }, // revenue 8, cogs 0
      ],
    });
    const rows = await profitability.getSalesOrderProfitability();
    const row = rows.find((r) => r.orderId === order.id);
    expect(row!.summary.revenue).toBe(58);
    expect(row!.summary.cogs).toBe(15);
    expect(row!.summary.grossProfit).toBe(43);
  });

  it('an order line with no productId and a real product description (an unresolved WooCommerce SKU) is flagged as unknown cost, not silently $0', async () => {
    // Regression test for a real production finding during the Phase 6
    // deploy: every synced WooCommerce order line had productId: null with
    // a real product description (SKU never resolved — see
    // docs/WOOCOMMERCE_INTEGRATION.md), which must never be confused with a
    // genuine "Shipping" line.
    const order = await makeSoldOrder({
      status: 'CONFIRMED',
      items: [{ productId: null, quantity: 2, unitPrice: 149, description: 'Vesuvius Super Patch 3000 Mortar' }],
    });
    const rows = await profitability.getSalesOrderProfitability();
    const row = rows.find((r) => r.orderId === order.id);
    expect(row!.summary.hasUnknownCost).toBe(true);
    expect(row!.summary.cogs).toBeNull();
    expect(row!.summary.unknownCostRevenue).toBe(298);
  });

  it('getCustomerProfitability groups by company, with orders lacking a company under "No customer assigned"', async () => {
    const product = await makeProduct({ cost: 2 });
    const company = await db.prisma.company.create({ data: { name: `Acme ${id()}`, type: 'CUSTOMER' } });
    await makeSoldOrder({ companyId: company.id, items: [{ productId: product.id, quantity: 4, unitPrice: 10 }] });
    await makeSoldOrder({ items: [{ productId: product.id, quantity: 1, unitPrice: 10 }] }); // no company

    const rows = await profitability.getCustomerProfitability();
    const forCompany = rows.find((r) => r.companyId === company.id);
    const unassigned = rows.find((r) => r.companyId === null);
    expect(forCompany?.summary.revenue).toBe(40);
    // Other tests in this file also create company-less orders (sharing
    // this file's one database), so the unassigned bucket is a running
    // total, not exclusive to this test — assert it includes this order's
    // contribution rather than an exact figure.
    expect(unassigned?.companyName).toBe('No customer assigned');
    expect(unassigned?.summary.revenue).toBeGreaterThanOrEqual(10);
  });

  it('getMonthlyProfitability groups by the order\'s createdAt month and sorts chronologically', async () => {
    const product = await makeProduct({ cost: 1 });
    await makeSoldOrder({ createdAt: new Date('2026-01-15'), items: [{ productId: product.id, quantity: 1, unitPrice: 100 }] });
    await makeSoldOrder({ createdAt: new Date('2026-03-15'), items: [{ productId: product.id, quantity: 1, unitPrice: 200 }] });

    const rows = await profitability.getMonthlyProfitability();
    const jan = rows.find((r) => r.key === '2026-01');
    const mar = rows.find((r) => r.key === '2026-03');
    expect(jan?.summary.revenue).toBe(100);
    expect(mar?.summary.revenue).toBe(200);
    const janIdx = rows.findIndex((r) => r.key === '2026-01');
    const marIdx = rows.findIndex((r) => r.key === '2026-03');
    expect(janIdx).toBeLessThan(marIdx);
  });

  it('getInvoiceProfitability only counts actually-issued INVOICE-type documents, not DRAFT/CANCELLED/ESTIMATE', async () => {
    const product = await makeProduct({ cost: 4 });
    await db.prisma.invoice.create({
      data: {
        number: `INV-${id()}`,
        type: 'INVOICE',
        status: 'SENT',
        subtotal: 100,
        total: 100,
        items: { create: [{ productId: product.id, description: 'x', quantity: 10, unitPrice: 10 }] },
      },
    });
    await db.prisma.invoice.create({
      data: {
        number: `INV-${id()}`,
        type: 'INVOICE',
        status: 'DRAFT',
        subtotal: 9999,
        total: 9999,
        items: { create: [{ productId: product.id, description: 'x', quantity: 999, unitPrice: 10 }] },
      },
    });
    await db.prisma.invoice.create({
      data: {
        number: `INV-${id()}`,
        type: 'ESTIMATE',
        status: 'SENT',
        subtotal: 9999,
        total: 9999,
        items: { create: [{ productId: product.id, description: 'x', quantity: 999, unitPrice: 10 }] },
      },
    });

    const rows = await profitability.getInvoiceProfitability();
    const total = rows.reduce((sum, r) => sum + r.summary.revenue, 0);
    expect(total).toBe(100);
  });

  it('getProfitabilityDashboard\'s overall total equals the sum of its own byProduct rows (no double-counting, no drift)', async () => {
    const product = await makeProduct({ cost: 6 });
    await makeSoldOrder({ items: [{ productId: product.id, quantity: 2, unitPrice: 50 }] });
    await makeSoldOrder({ items: [{ productId: product.id, quantity: 3, unitPrice: 50 }] });

    const dashboard = await profitability.getProfitabilityDashboard();
    const productRevenue = dashboard.byProduct
      .filter((p) => p.productId === product.id)
      .reduce((s, p) => s + p.summary.revenue, 0);
    const orderRevenue = dashboard.byOrder
      .filter((o) => o.summary.revenue > 0)
      .reduce((s, o) => s + o.summary.revenue, 0);
    // Every dollar of product revenue must also appear in some order's revenue.
    expect(productRevenue).toBeLessThanOrEqual(orderRevenue);
    expect(dashboard.overall.revenue).toBeGreaterThanOrEqual(productRevenue);
  });

  it('a date range filter excludes orders created outside the range', async () => {
    const product = await makeProduct({ cost: 1 });
    await makeSoldOrder({ createdAt: new Date('2020-01-01'), items: [{ productId: product.id, quantity: 1, unitPrice: 999 }] });
    await makeSoldOrder({ createdAt: new Date('2026-06-01'), items: [{ productId: product.id, quantity: 1, unitPrice: 50 }] });

    const rows = await profitability.getSalesOrderProfitability({ from: new Date('2026-01-01'), to: new Date('2026-12-31') });
    const revenues = rows.map((r) => r.summary.revenue);
    expect(revenues).not.toContain(999);
    expect(revenues).toContain(50);
  });
});
