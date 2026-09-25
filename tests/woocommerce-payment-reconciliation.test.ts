import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import type { TestDb } from './test-db';
import { startTestDb } from './test-db';

/**
 * Phase 11 (SYSTEM_AUDIT.md L, K): WooCommerce paid-order -> Payment
 * reconciliation, idempotency, and distinct refund handling. Same fetch-
 * stubbing harness as tests/woocommerce-sync.test.ts (Phase 2) — a fresh
 * file/database per the one-describe-per-file convention, since this is a
 * genuinely separate concern (financial reconciliation, not sync mapping).
 * See docs/FINANCIAL_ACCURACY_AND_AUTOMATION.md.
 */
describe('WooCommerce payment reconciliation (Phase 11)', () => {
  let db: TestDb;
  let syncWooCommerce: typeof import('../src/lib/wordpress/woocommerce')['syncWooCommerce'];
  let getFinanceSummary: typeof import('../src/lib/finance')['getFinanceSummary'];

  type MockData = { customers: unknown[]; products: unknown[]; orders: unknown[] };
  let mockData: MockData;

  beforeAll(async () => {
    db = await startTestDb();
    process.env.DATABASE_URL = db.url;
    process.env.WOOCOMMERCE_CONSUMER_KEY = 'ck_test';
    process.env.WOOCOMMERCE_CONSUMER_SECRET = 'cs_test';

    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        const page = Number(new URL(url).searchParams.get('page') ?? '1');
        const endpoint = url.includes('/customers') ? 'customers' : url.includes('/products') ? 'products' : url.includes('/orders') ? 'orders' : null;
        const data = page === 1 && endpoint ? mockData[endpoint as keyof MockData] : [];
        return { ok: true, status: 200, json: async () => data } as Response;
      })
    );

    const wooMod = await import('../src/lib/wordpress/woocommerce');
    syncWooCommerce = wooMod.syncWooCommerce;
    const financeMod = await import('../src/lib/finance');
    getFinanceSummary = financeMod.getFinanceSummary;
  }, 60000);

  afterAll(async () => {
    await db.stop();
    vi.unstubAllGlobals();
  });

  let siteId: string;
  let runId: string;
  let nextNumericId: number;

  beforeEach(async () => {
    const site = await db.prisma.wordPressSite.create({ data: { name: `Test Site ${Math.random()}`, baseUrl: 'https://shop.example.test' } });
    siteId = site.id;
    mockData = { customers: [], products: [], orders: [] };
    runId = Math.random().toString(36).slice(2, 8);
    nextNumericId = Math.floor(Math.random() * 1_000_000) + 100_000;
  });

  function wooOrder(overrides: Partial<Record<string, unknown>> = {}) {
    return {
      id: nextNumericId,
      number: String(nextNumericId),
      status: 'processing',
      total: '25.00',
      total_tax: '2.00',
      discount_total: '0.00',
      shipping_total: '5.00',
      currency: 'USD',
      billing: { email: `jane-${runId}@example.com`, first_name: 'Jane', last_name: 'Doe' },
      line_items: [{ name: 'Standard Brick', quantity: 2, price: '9.00', sku: `BRICK-${runId}`, subtotal: '18.00' }],
      ...overrides,
    };
  }

  async function findSyncedOrder(orderId: number) {
    return db.prisma.salesOrder.findFirstOrThrow({ where: { externalSource: 'woocommerce', externalId: String(orderId) } });
  }

  async function findSyncedPayment(orderId: number) {
    return db.prisma.payment.findUnique({ where: { externalSource_externalId: { externalSource: 'woocommerce', externalId: String(orderId) } } });
  }

  describe('item L — paid orders record a Payment', () => {
    it("a 'processing' order auto-creates an Invoice and a full Payment, marking the invoice PAID", async () => {
      const order = wooOrder({ status: 'processing', total: '25.00' });
      mockData.orders = [order];
      await syncWooCommerce(siteId);

      const salesOrder = await findSyncedOrder(order.id);
      const invoice = await db.prisma.invoice.findFirstOrThrow({ where: { salesOrderId: salesOrder.id } });
      expect(Number(invoice.total)).toBe(25);
      expect(Number(invoice.amountPaid)).toBe(25);
      expect(invoice.status).toBe('PAID');

      const payment = await findSyncedPayment(order.id);
      expect(payment).not.toBeNull();
      expect(Number(payment!.amount)).toBe(25);
      expect(payment!.invoiceId).toBe(invoice.id);
    });

    it("a 'completed' order also records a payment", async () => {
      const order = wooOrder({ status: 'completed', total: '40.00' });
      mockData.orders = [order];
      await syncWooCommerce(siteId);

      const payment = await findSyncedPayment(order.id);
      expect(payment).not.toBeNull();
      expect(Number(payment!.amount)).toBe(40);
    });

    it('uses payment_method_title when WooCommerce provides one, falling back to "WooCommerce" otherwise', async () => {
      const withMethod = wooOrder({ payment_method_title: 'Credit Card (Stripe)' });
      mockData.orders = [withMethod];
      await syncWooCommerce(siteId);
      const payment = await findSyncedPayment(withMethod.id);
      expect(payment!.method).toBe('Credit Card (Stripe)');

      const withoutMethod = wooOrder({ id: nextNumericId + 1, number: String(nextNumericId + 1) });
      mockData.orders = [withoutMethod];
      await syncWooCommerce(siteId);
      const payment2 = await findSyncedPayment(withoutMethod.id);
      expect(payment2!.method).toBe('WooCommerce');
    });

    it('a non-paid order status (pending/on-hold) records no Payment and no Invoice', async () => {
      const order = wooOrder({ status: 'pending' });
      mockData.orders = [order];
      await syncWooCommerce(siteId);

      const salesOrder = await findSyncedOrder(order.id);
      const invoice = await db.prisma.invoice.findFirst({ where: { salesOrderId: salesOrder.id } });
      expect(invoice).toBeNull();
      const payment = await findSyncedPayment(order.id);
      expect(payment).toBeNull();
    });

    it('idempotency: re-syncing the same paid order does not create a second Payment or a second Invoice', async () => {
      const order = wooOrder();
      mockData.orders = [order];
      await syncWooCommerce(siteId);
      await syncWooCommerce(siteId);
      await syncWooCommerce(siteId);

      const salesOrder = await findSyncedOrder(order.id);
      const invoices = await db.prisma.invoice.findMany({ where: { salesOrderId: salesOrder.id } });
      expect(invoices).toHaveLength(1);
      const payments = await db.prisma.payment.findMany({
        where: { externalSource: 'woocommerce', externalId: String(order.id) },
      });
      expect(payments).toHaveLength(1);
      expect(Number(invoices[0].amountPaid)).toBe(Number(order.total)); // not doubled/tripled
    });

    it('reuses a pre-existing manually-created invoice for the order instead of creating a duplicate', async () => {
      const order = wooOrder({ status: 'pending' }); // sync first without triggering payment recording
      mockData.orders = [order];
      await syncWooCommerce(siteId);
      const salesOrder = await findSyncedOrder(order.id);

      const manualInvoice = await db.prisma.invoice.create({
        data: { number: `INV-${runId}`, type: 'INVOICE', salesOrderId: salesOrder.id, companyId: salesOrder.companyId, subtotal: 25, total: 25 },
      });

      mockData.orders = [wooOrder({ id: order.id, number: order.number, status: 'processing' })];
      await syncWooCommerce(siteId);

      const invoices = await db.prisma.invoice.findMany({ where: { salesOrderId: salesOrder.id } });
      expect(invoices).toHaveLength(1);
      expect(invoices[0].id).toBe(manualInvoice.id);
      const updated = await db.prisma.invoice.findUniqueOrThrow({ where: { id: manualInvoice.id } });
      expect(Number(updated.amountPaid)).toBe(25);
      expect(updated.status).toBe('PAID');
    });

    it("getFinanceSummary's cash-received figure reflects the auto-recorded payment", async () => {
      const before = await getFinanceSummary();
      const order = wooOrder({ total: '99.00' });
      mockData.orders = [order];
      await syncWooCommerce(siteId);
      const after = await getFinanceSummary();

      expect(after.current.received).toBeCloseTo(before.current.received + 99, 2);
    });
  });

  describe('item K — refunded orders are distinct from cancelled', () => {
    it("'cancelled' and 'failed' still map to CANCELLED (unchanged regression check)", async () => {
      const cancelled = wooOrder({ status: 'cancelled' });
      mockData.orders = [cancelled];
      await syncWooCommerce(siteId);
      expect((await findSyncedOrder(cancelled.id)).status).toBe('CANCELLED');

      const failed = wooOrder({ id: nextNumericId + 1, number: String(nextNumericId + 1), status: 'failed' });
      mockData.orders = [failed];
      await syncWooCommerce(siteId);
      expect((await findSyncedOrder(failed.id)).status).toBe('CANCELLED');
    });

    it("a 'refunded' order maps to REFUNDED, not CANCELLED", async () => {
      const order = wooOrder({ status: 'refunded' });
      mockData.orders = [order];
      await syncWooCommerce(siteId);
      expect((await findSyncedOrder(order.id)).status).toBe('REFUNDED');
    });

    it('a full lifecycle — paid then refunded — reverses the payment: refundedAmount set, invoice amountPaid returns to 0, status back to SENT', async () => {
      const order = wooOrder({ status: 'processing', total: '25.00' });
      mockData.orders = [order];
      await syncWooCommerce(siteId); // paid

      let payment = await findSyncedPayment(order.id);
      expect(Number(payment!.amount)).toBe(25);
      expect(Number(payment!.refundedAmount)).toBe(0);

      mockData.orders = [wooOrder({ id: order.id, number: order.number, status: 'refunded', total: '25.00' })];
      await syncWooCommerce(siteId); // refunded

      payment = await findSyncedPayment(order.id);
      expect(Number(payment!.refundedAmount)).toBe(25);

      const salesOrder = await findSyncedOrder(order.id);
      expect(salesOrder.status).toBe('REFUNDED');
      const invoice = await db.prisma.invoice.findUniqueOrThrow({ where: { id: payment!.invoiceId } });
      expect(Number(invoice.amountPaid)).toBe(0);
      expect(invoice.status).toBe('SENT');
    });

    it('idempotency: re-syncing an already-refunded order does not double-reverse (refundedAmount stays at the original amount, amountPaid does not go negative)', async () => {
      const order = wooOrder({ status: 'processing', total: '25.00' });
      mockData.orders = [order];
      await syncWooCommerce(siteId);
      mockData.orders = [wooOrder({ id: order.id, number: order.number, status: 'refunded' })];
      await syncWooCommerce(siteId);
      await syncWooCommerce(siteId);
      await syncWooCommerce(siteId);

      const payment = await findSyncedPayment(order.id);
      expect(Number(payment!.refundedAmount)).toBe(25); // not 50, 75, ...
      const invoice = await db.prisma.invoice.findUniqueOrThrow({ where: { id: payment!.invoiceId } });
      expect(Number(invoice.amountPaid)).toBe(0); // never negative
    });

    it('a refund for an order that was never recorded as paid logs a warning and does not fabricate a payment', async () => {
      const order = wooOrder({ status: 'refunded' }); // refunded on its very first sync — never went through 'processing'
      mockData.orders = [order];
      const result = await syncWooCommerce(siteId);

      expect(result.warnings.some((w) => w.includes('nothing to reverse'))).toBe(true);
      const payment = await findSyncedPayment(order.id);
      expect(payment).toBeNull();
      const logs = await db.prisma.automationLog.findMany({ where: { entityType: 'WOOCOMMERCE_SYNC', entityId: String(order.id), success: false } });
      expect(logs.length).toBeGreaterThan(0);
    });

    it('a refund does not count toward Finance "sold", the same way a cancellation already does not', async () => {
      const before = await getFinanceSummary();
      const order = wooOrder({ status: 'processing', total: '60.00' });
      mockData.orders = [order];
      await syncWooCommerce(siteId);
      mockData.orders = [wooOrder({ id: order.id, number: order.number, status: 'refunded' })];
      await syncWooCommerce(siteId);
      const after = await getFinanceSummary();

      // "sold" is filtered by current status ∈ {CONFIRMED,SHIPPED,DELIVERED}
      // — REFUNDED is excluded from that set, so this order's total must
      // not appear in "sold" once refunded.
      expect(after.current.sold).toBeCloseTo(before.current.sold, 2);
    });
  });
});
