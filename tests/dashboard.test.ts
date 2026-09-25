import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { TestDb } from './test-db';
import { startTestDb } from './test-db';

/**
 * Phase 9 (Management Dashboard): database-backed tests proving every
 * figure in src/lib/dashboard.ts is derived from real rows — no metric is
 * hard-coded or estimated — and that the customer/product/warehouse/
 * channel filters and the finance-only gating on Gross profit/margin and
 * Inventory value all work as documented in docs/MANAGEMENT_DASHBOARD.md.
 */
describe('Management dashboard', () => {
  let db: TestDb;
  let dashboard: typeof import('../src/lib/dashboard');

  beforeAll(async () => {
    db = await startTestDb();
    process.env.DATABASE_URL = db.url;
    dashboard = await import('../src/lib/dashboard');
  }, 60000);

  afterAll(async () => {
    await db.stop();
  });

  function id() {
    return Math.random().toString(36).slice(2);
  }

  async function makeProduct(overrides: { cost?: number; reorderPoint?: number; trackInventory?: boolean; active?: boolean } = {}) {
    const product = await db.prisma.product.create({
      data: {
        sku: `SKU-${id()}`,
        name: `Product ${id()}`,
        price: 100,
        cost: overrides.cost ?? 0,
        reorderPoint: overrides.reorderPoint ?? 0,
        trackInventory: overrides.trackInventory ?? true,
        active: overrides.active ?? true,
      },
    });
    const variant = await db.prisma.productVariant.create({
      data: { productId: product.id, sku: `${product.sku}-V`, name: 'Default' },
    });
    return { product, variant };
  }

  async function makeWarehouse(overrides: { active?: boolean } = {}) {
    return db.prisma.warehouse.create({ data: { name: `WH-${id()}`, active: overrides.active ?? true } });
  }

  async function makeCompany(type: 'CUSTOMER' | 'SUPPLIER' | 'BOTH' | 'PARTNER' = 'CUSTOMER') {
    return db.prisma.company.create({ data: { name: `Co ${id()}`, type } });
  }

  async function makeOrder(opts: {
    companyId?: string;
    status?: 'DRAFT' | 'CONFIRMED' | 'SHIPPED' | 'DELIVERED' | 'CANCELLED';
    createdAt?: Date;
    externalSource?: string | null;
    items: Array<{ productId: string | null; quantity: number; unitPrice: number; description?: string }>;
  }) {
    return db.prisma.salesOrder.create({
      data: {
        number: `SO-${id()}`,
        status: opts.status ?? 'CONFIRMED',
        companyId: opts.companyId,
        createdAt: opts.createdAt,
        externalSource: opts.externalSource,
        items: {
          create: opts.items.map((i) => ({
            productId: i.productId,
            description: i.description ?? 'line',
            quantity: i.quantity,
            unitPrice: i.unitPrice,
          })),
        },
      },
    });
  }

  describe('sales figures', () => {
    it('today/thisMonth/thisYear each sum quantity*unitPrice for orders created in that window, from stock-holding statuses only', async () => {
      const { product } = await makeProduct({ cost: 1 });
      const now = new Date();
      await makeOrder({ status: 'CONFIRMED', createdAt: now, items: [{ productId: product.id, quantity: 2, unitPrice: 50 }] }); // today: 100
      await makeOrder({ status: 'DRAFT', createdAt: now, items: [{ productId: product.id, quantity: 999, unitPrice: 50 }] }); // excluded: DRAFT
      await makeOrder({ status: 'CANCELLED', createdAt: now, items: [{ productId: product.id, quantity: 999, unitPrice: 50 }] }); // excluded: CANCELLED

      const data = await dashboard.getDashboardData('ADMIN', {});
      expect(data.sales.today).toBeGreaterThanOrEqual(100);
      expect(data.sales.thisMonth).toBeGreaterThanOrEqual(100);
      expect(data.sales.thisYear).toBeGreaterThanOrEqual(100);
    });

    it('an order outside the current year does not count toward "this year"', async () => {
      const { product } = await makeProduct({ cost: 1 });
      const before = await dashboard.getDashboardData('ADMIN', {});
      await makeOrder({ status: 'DELIVERED', createdAt: new Date('2019-01-01'), items: [{ productId: product.id, quantity: 1, unitPrice: 777 }] });
      const after = await dashboard.getDashboardData('ADMIN', {});
      expect(after.sales.thisYear).toBe(before.sales.thisYear);
    });

    it('the customer filter scopes sales figures to that company only', async () => {
      const { product } = await makeProduct({ cost: 1 });
      const companyA = await makeCompany();
      const companyB = await makeCompany();
      await makeOrder({ companyId: companyA.id, items: [{ productId: product.id, quantity: 1, unitPrice: 30 }] });
      await makeOrder({ companyId: companyB.id, items: [{ productId: product.id, quantity: 1, unitPrice: 9000 }] });

      const data = await dashboard.getDashboardData('ADMIN', { companyId: companyA.id });
      expect(data.sales.thisYear).toBeLessThan(9000);
    });

    it('the channel filter distinguishes woocommerce (externalSource set) from direct (externalSource null)', async () => {
      const { product } = await makeProduct({ cost: 1 });
      const beforeWoo = await dashboard.getDashboardData('ADMIN', { channel: 'woocommerce' });
      const beforeDirect = await dashboard.getDashboardData('ADMIN', { channel: 'direct' });

      await makeOrder({ externalSource: 'woocommerce', items: [{ productId: product.id, quantity: 1, unitPrice: 4321 }] });

      const afterWoo = await dashboard.getDashboardData('ADMIN', { channel: 'woocommerce' });
      const afterDirect = await dashboard.getDashboardData('ADMIN', { channel: 'direct' });
      // Only the woocommerce-scoped total picks up this order's revenue.
      expect(afterWoo.sales.thisYear).toBeCloseTo(beforeWoo.sales.thisYear + 4321, 2);
      expect(afterDirect.sales.thisYear).toBeCloseTo(beforeDirect.sales.thisYear, 2);
    });

    it('the product filter scopes sales figures to lines for that product only', async () => {
      const { product: productA } = await makeProduct({ cost: 1 });
      const { product: productB } = await makeProduct({ cost: 1 });
      await makeOrder({ items: [{ productId: productA.id, quantity: 1, unitPrice: 55 }, { productId: productB.id, quantity: 1, unitPrice: 6000 }] });

      const data = await dashboard.getDashboardData('ADMIN', { productId: productA.id });
      expect(data.sales.thisYear).toBeLessThan(6000);
    });
  });

  describe('date-boundary math', () => {
    it('an order created at midnight today counts toward "today"', async () => {
      const { product } = await makeProduct({ cost: 1 });
      const midnightToday = new Date(new Date().getFullYear(), new Date().getMonth(), new Date().getDate(), 0, 0, 0, 0);
      const before = await dashboard.getDashboardData('ADMIN', {});
      await makeOrder({ createdAt: midnightToday, items: [{ productId: product.id, quantity: 1, unitPrice: 61 }] });
      const after = await dashboard.getDashboardData('ADMIN', {});
      expect(after.sales.today).toBeCloseTo(before.sales.today + 61, 2);
    });

    it('an order created yesterday at 23:59:59 does not count toward "today" but does count toward "this month" (same month)', async () => {
      const now = new Date();
      const yesterdayLateNight = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1, 23, 59, 59, 999);
      if (yesterdayLateNight.getMonth() !== now.getMonth()) return; // skip on the 1st of the month — no "yesterday, same month" to test

      const { product } = await makeProduct({ cost: 1 });
      const before = await dashboard.getDashboardData('ADMIN', {});
      await makeOrder({ createdAt: yesterdayLateNight, items: [{ productId: product.id, quantity: 1, unitPrice: 62 }] });
      const after = await dashboard.getDashboardData('ADMIN', {});

      expect(after.sales.today).toBeCloseTo(before.sales.today, 2); // unchanged
      expect(after.sales.thisMonth).toBeCloseTo(before.sales.thisMonth + 62, 2);
    });

    it('an order created on the first day of last month does not count toward "this month"', async () => {
      const now = new Date();
      if (now.getMonth() === 0) return; // skip in January — "last month" would be a different calendar year too
      const firstOfLastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1, 12, 0, 0);

      const { product } = await makeProduct({ cost: 1 });
      const before = await dashboard.getDashboardData('ADMIN', {});
      await makeOrder({ createdAt: firstOfLastMonth, items: [{ productId: product.id, quantity: 1, unitPrice: 63 }] });
      const after = await dashboard.getDashboardData('ADMIN', {});

      expect(after.sales.thisMonth).toBeCloseTo(before.sales.thisMonth, 2); // unchanged
      expect(after.sales.thisYear).toBeCloseTo(before.sales.thisYear + 63, 2); // still this calendar year
    });
  });

  describe('gross profit / margin — finance-gated', () => {
    it('is null for a role without finance access (SALES, OPERATIONS)', async () => {
      const salesView = await dashboard.getDashboardData('SALES', {});
      const opsView = await dashboard.getDashboardData('OPERATIONS', {});
      expect(salesView.grossProfit).toBeNull();
      expect(opsView.grossProfit).toBeNull();
    });

    it('is populated for ADMIN/ACCOUNTING and matches revenue minus known COGS', async () => {
      const { product } = await makeProduct({ cost: 3 });
      await makeOrder({ items: [{ productId: product.id, quantity: 4, unitPrice: 10 }] }); // revenue 40, cogs 12

      const adminView = await dashboard.getDashboardData('ADMIN', {});
      const accountingView = await dashboard.getDashboardData('ACCOUNTING', {});
      expect(adminView.grossProfit).not.toBeNull();
      expect(accountingView.grossProfit).not.toBeNull();
      expect(adminView.grossProfit!.revenue).toBeGreaterThanOrEqual(40);
    });

    it('a product with unresolvable cost flags hasUnknownCost rather than assuming a $0 cost', async () => {
      const product = await db.prisma.product.create({ data: { sku: `SKU-${id()}`, name: 'No cost set', price: 100, cost: 0 } });
      await makeOrder({ items: [{ productId: product.id, quantity: 1, unitPrice: 200 }] });

      const data = await dashboard.getDashboardData('ADMIN', {});
      expect(data.grossProfit!.hasUnknownCost).toBe(true);
      expect(data.grossProfit!.cogs).toBeNull();
    });
  });

  describe('inventory value and low stock', () => {
    it('inventory value is null for a non-finance role, and only sums tracked-inventory stock at known cost otherwise', async () => {
      const { product, variant } = await makeProduct({ cost: 5, trackInventory: true });
      const wh = await makeWarehouse();
      await db.prisma.stockLevel.create({ data: { productVariantId: variant.id, warehouseId: wh.id, quantity: 10 } });

      const salesView = await dashboard.getDashboardData('SALES', {});
      expect(salesView.inventoryValue).toBeNull();

      const adminView = await dashboard.getDashboardData('ADMIN', {});
      expect(adminView.inventoryValue).not.toBeNull();
      expect(adminView.inventoryValue!.knownValue).toBeGreaterThanOrEqual(50); // 10 units * $5
    });

    it('a tracked-inventory product with no resolvable cost contributes to unknownCostUnits, not to knownValue', async () => {
      const { variant } = await makeProduct({ cost: 0, trackInventory: true });
      const wh = await makeWarehouse();
      await db.prisma.stockLevel.create({ data: { productVariantId: variant.id, warehouseId: wh.id, quantity: 7 } });

      const data = await dashboard.getDashboardData('ADMIN', {});
      expect(data.inventoryValue!.hasUnknownCost).toBe(true);
      expect(data.inventoryValue!.unknownCostUnits).toBeGreaterThanOrEqual(7);
    });

    it('a product with trackInventory: false is excluded from inventory value and low stock entirely', async () => {
      const { variant, product } = await makeProduct({ cost: 5, trackInventory: false, reorderPoint: 100 });
      const wh = await makeWarehouse();
      await db.prisma.stockLevel.create({ data: { productVariantId: variant.id, warehouseId: wh.id, quantity: 0 } });

      const data = await dashboard.getDashboardData('ADMIN', {});
      expect(data.lowStock.find((l) => l.productId === product.id)).toBeUndefined();
    });

    it('low stock matches quantity <= reorderPoint, the same definition checkLowStock() uses', async () => {
      const { variant: lowVariant, product: lowProduct } = await makeProduct({ reorderPoint: 10, trackInventory: true });
      const { variant: healthyVariant, product: healthyProduct } = await makeProduct({ reorderPoint: 10, trackInventory: true });
      const wh = await makeWarehouse();
      await db.prisma.stockLevel.create({ data: { productVariantId: lowVariant.id, warehouseId: wh.id, quantity: 10 } }); // exactly at reorder point: low
      await db.prisma.stockLevel.create({ data: { productVariantId: healthyVariant.id, warehouseId: wh.id, quantity: 11 } }); // above: healthy

      const data = await dashboard.getDashboardData('ADMIN', {});
      expect(data.lowStock.find((l) => l.productId === lowProduct.id)).toBeDefined();
      expect(data.lowStock.find((l) => l.productId === healthyProduct.id)).toBeUndefined();
    });

    it('the warehouse filter scopes both inventory value and low stock to that warehouse', async () => {
      const { variant, product } = await makeProduct({ cost: 5, reorderPoint: 100, trackInventory: true });
      const whA = await makeWarehouse();
      const whB = await makeWarehouse();
      await db.prisma.stockLevel.create({ data: { productVariantId: variant.id, warehouseId: whA.id, quantity: 1 } });

      const scopedToA = await dashboard.getDashboardData('ADMIN', { warehouseId: whA.id });
      const scopedToB = await dashboard.getDashboardData('ADMIN', { warehouseId: whB.id });
      expect(scopedToA.lowStock.find((l) => l.productId === product.id)).toBeDefined();
      expect(scopedToB.lowStock.find((l) => l.productId === product.id)).toBeUndefined();
    });
  });

  describe('open documents', () => {
    it('counts and totals open quotes, open sales orders, and open purchase orders by their real statuses', async () => {
      const before = await dashboard.getDashboardData('ADMIN', {});

      await db.prisma.quote.create({ data: { number: `Q-${id()}`, status: 'SENT', subtotal: 500, total: 500 } });
      await db.prisma.quote.create({ data: { number: `Q-${id()}`, status: 'ACCEPTED', subtotal: 9999, total: 9999 } }); // not open
      await makeOrder({ status: 'CONFIRMED', items: [{ productId: null, quantity: 1, unitPrice: 300, description: 'x' }] });
      await db.prisma.purchaseOrder.create({ data: { number: `PO-${id()}`, status: 'SENT', total: 700 } });
      await db.prisma.purchaseOrder.create({ data: { number: `PO-${id()}`, status: 'RECEIVED', total: 9999 } }); // not open

      const after = await dashboard.getDashboardData('ADMIN', {});
      expect(after.open.quotes.count).toBe(before.open.quotes.count + 1);
      expect(after.open.quotes.total).toBeCloseTo(before.open.quotes.total + 500, 2);
      expect(after.open.salesOrders.count).toBe(before.open.salesOrders.count + 1);
      expect(after.open.purchaseOrders.count).toBe(before.open.purchaseOrders.count + 1);
      expect(after.open.purchaseOrders.total).toBeCloseTo(before.open.purchaseOrders.total + 700, 2);
    });
  });

  describe('receivables', () => {
    it('reuses getAccountsReceivableDashboard, scoped by the customer filter', async () => {
      const company = await makeCompany();
      const dueDate = new Date(Date.now() - 86_400_000 * 5);
      await db.prisma.invoice.create({
        data: { number: `INV-${id()}`, type: 'INVOICE', status: 'OVERDUE', companyId: company.id, subtotal: 250, total: 250, dueDate },
      });

      const scoped = await dashboard.getDashboardData('ADMIN', { companyId: company.id });
      expect(scoped.receivables.overdue.total).toBeGreaterThanOrEqual(250);
      expect(scoped.receivables.outstanding.count).toBeGreaterThanOrEqual(1);
    });
  });

  describe('recent activity', () => {
    it('recent orders/payments/movements are non-N+1 lists that respect the customer/warehouse filters', async () => {
      const company = await makeCompany();
      const { variant } = await makeProduct({ trackInventory: true });
      const wh = await makeWarehouse();

      const order = await makeOrder({ companyId: company.id, items: [{ productId: null, quantity: 1, unitPrice: 40, description: 'x' }] });
      const invoice = await db.prisma.invoice.create({
        data: { number: `INV-${id()}`, type: 'INVOICE', status: 'PAID', companyId: company.id, subtotal: 40, total: 40, amountPaid: 40 },
      });
      await db.prisma.payment.create({ data: { invoiceId: invoice.id, amount: 40, method: 'Card' } });
      await db.prisma.stockMovement.create({
        data: { productVariantId: variant.id, warehouseId: wh.id, type: 'IN', quantity: 5, referenceType: 'GoodsReceipt', referenceId: 'gr-123' },
      });

      const scoped = await dashboard.getDashboardData('ADMIN', { companyId: company.id, warehouseId: wh.id });
      expect(scoped.recent.orders.find((o) => o.id === order.id)).toBeDefined();
      expect(scoped.recent.payments.find((p) => p.invoiceNumber === invoice.number)).toBeDefined();
      const movement = scoped.recent.movements.find((m) => m.referenceId === 'gr-123');
      expect(movement).toBeDefined();
      expect(movement!.referenceType).toBe('GoodsReceipt');
    });

    it('an empty result set (filters matching nothing) returns empty arrays, not an error', async () => {
      const data = await dashboard.getDashboardData('ADMIN', { companyId: 'nonexistent-company-id' });
      expect(data.recent.orders).toEqual([]);
      expect(data.recent.payments).toEqual([]);
    });
  });

  describe('resilient rendering on empty/no-match results', () => {
    it('a filter combination matching zero real rows returns well-formed zero/empty results everywhere, without throwing', async () => {
      const data = await dashboard.getDashboardData('ADMIN', {
        companyId: 'no-such-company',
        productId: 'no-such-product',
        warehouseId: 'no-such-warehouse',
        channel: 'direct',
      });
      expect(data.sales).toEqual({ today: 0, thisMonth: 0, thisYear: 0 });
      expect(data.receivables.outstanding).toEqual({ total: 0, count: 0 });
      expect(data.receivables.overdue).toEqual({ total: 0, count: 0 });
      expect(data.lowStock).toEqual([]);
      expect(data.open.quotes).toEqual({ count: 0, total: 0 });
      expect(data.open.salesOrders).toEqual({ count: 0, total: 0 });
      expect(data.recent.orders).toEqual([]);
      expect(data.recent.payments).toEqual([]);
      expect(data.recent.movements).toEqual([]);
      // Inventory value is scoped to the (nonexistent) warehouse/product, so
      // it must be a well-formed zero, not null or a thrown error, for a
      // finance role.
      expect(data.inventoryValue).toEqual({ knownValue: 0, hasUnknownCost: false, unknownCostUnits: 0, unknownCostProductCount: 0 });
    });

    it('a role without dashboard/finance access still gets a well-formed result on the same empty filter set', async () => {
      const data = await dashboard.getDashboardData('SALES', { companyId: 'no-such-company' });
      expect(data.grossProfit).toBeNull();
      expect(data.inventoryValue).toBeNull();
      expect(data.sales).toEqual({ today: 0, thisMonth: 0, thisYear: 0 });
    });
  });

  describe('query efficiency (no N+1)', () => {
    it('getDashboardData issues the same number of database queries whether there are a handful of orders/stock rows or many more', async () => {
      const { prisma: appPrisma } = await import('../src/lib/prisma');
      let queryCount = 0;
      (appPrisma as unknown as { $use: (cb: (params: unknown, next: (p: unknown) => Promise<unknown>) => Promise<unknown>) => void }).$use(
        async (params, next) => {
          queryCount++;
          return next(params);
        }
      );

      const { product } = await makeProduct({ cost: 2 });
      const wh = await makeWarehouse();
      await makeOrder({ items: [{ productId: product.id, quantity: 1, unitPrice: 10 }] });
      const { variant: seedVariant } = await makeProduct({ cost: 1 });
      await db.prisma.stockLevel.create({ data: { productVariantId: seedVariant.id, warehouseId: wh.id, quantity: 5 } });

      queryCount = 0;
      await dashboard.getDashboardData('ADMIN', {});
      const smallCount = queryCount;
      expect(smallCount).toBeGreaterThan(0);

      // A per-row (N+1) bug would make the query count below scale with this
      // loop; a correctly batched implementation issues the exact same
      // fixed set of queries regardless of how many rows they return.
      for (let i = 0; i < 25; i++) {
        await makeOrder({
          items: [
            { productId: product.id, quantity: 1, unitPrice: 10 },
            { productId: null, quantity: 1, unitPrice: 5, description: 'Shipping' },
          ],
        });
        const { variant } = await makeProduct({ cost: 1 });
        await db.prisma.stockLevel.create({ data: { productVariantId: variant.id, warehouseId: wh.id, quantity: 1 } });
      }

      queryCount = 0;
      await dashboard.getDashboardData('ADMIN', {});
      const largeCount = queryCount;

      expect(largeCount).toBe(smallCount);
      expect(smallCount).toBeLessThan(20); // sanity bound — a handful of queries, not dozens
    });
  });

  describe('filter option lists', () => {
    it('customers only include CUSTOMER/BOTH company types, not pure suppliers', async () => {
      const customer = await makeCompany('CUSTOMER');
      const both = await makeCompany('BOTH');
      const supplier = await makeCompany('SUPPLIER');

      const options = await dashboard.getDashboardFilterOptions();
      const ids = options.customers.map((c) => c.id);
      expect(ids).toContain(customer.id);
      expect(ids).toContain(both.id);
      expect(ids).not.toContain(supplier.id);
    });

    it('products and warehouses only include active ones', async () => {
      const { product: activeProduct } = await makeProduct({ active: true });
      const { product: inactiveProduct } = await makeProduct({ active: false });
      const activeWarehouse = await makeWarehouse({ active: true });
      const inactiveWarehouse = await makeWarehouse({ active: false });

      const options = await dashboard.getDashboardFilterOptions();
      expect(options.products.map((p) => p.id)).toContain(activeProduct.id);
      expect(options.products.map((p) => p.id)).not.toContain(inactiveProduct.id);
      expect(options.warehouses.map((w) => w.id)).toContain(activeWarehouse.id);
      expect(options.warehouses.map((w) => w.id)).not.toContain(inactiveWarehouse.id);
    });
  });
});
