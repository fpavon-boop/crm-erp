import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import type { TestDb } from './test-db';
import { startTestDb } from './test-db';

/**
 * Phase 2 (WooCommerce hardening). syncWooCommerce() talks to a real
 * WooCommerce REST API over HTTP, so these tests stub global fetch with
 * canned WooCommerce-shaped responses rather than hitting a real store —
 * everything else (the database side) is the real, hardened sync logic
 * running against a real migrated Postgres instance. See
 * docs/WOOCOMMERCE_INTEGRATION.md.
 */
describe('WooCommerce sync (Phase 2)', () => {
  let db: TestDb;
  let syncWooCommerce: typeof import('../src/lib/wordpress/woocommerce')['syncWooCommerce'];

  type MockData = {
    customers: unknown[];
    products: unknown[];
    orders: unknown[];
  };
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
        const endpoint = url.includes('/customers')
          ? 'customers'
          : url.includes('/products')
            ? 'products'
            : url.includes('/orders')
              ? 'orders'
              : null;
        const data = page === 1 && endpoint ? mockData[endpoint as keyof MockData] : [];
        return {
          ok: true,
          status: 200,
          json: async () => data,
        } as Response;
      })
    );

    const mod = await import('../src/lib/wordpress/woocommerce');
    syncWooCommerce = mod.syncWooCommerce;
  }, 60000);

  afterAll(async () => {
    await db.stop();
    vi.unstubAllGlobals();
  });

  let warehouseId: string;
  let siteId: string;
  // Every test in this file shares one database (one startTestDb() per
  // file, per the established harness constraint), so each test gets its
  // own unique run of WooCommerce ids/SKUs/emails to avoid colliding with
  // Product.sku's/ProductVariant.sku's global uniqueness (or any other
  // test's data) across tests.
  let runId: string;
  let nextNumericId: number;

  beforeEach(async () => {
    await db.prisma.warehouse.updateMany({ where: { isDefault: true }, data: { isDefault: false } });
    const wh = await db.prisma.warehouse.create({ data: { name: `WH-${Math.random()}`, isDefault: true } });
    warehouseId = wh.id;

    const site = await db.prisma.wordPressSite.create({
      data: { name: `Test Site ${Math.random()}`, baseUrl: 'https://shop.example.test' },
    });
    siteId = site.id;

    mockData = { customers: [], products: [], orders: [] };
    runId = Math.random().toString(36).slice(2, 8);
    nextNumericId = Math.floor(Math.random() * 1_000_000) + 100_000;
  });

  function wooCustomer(overrides: Partial<Record<string, unknown>> = {}) {
    return {
      id: nextNumericId,
      email: `jane-${runId}@example.com`,
      first_name: 'Jane',
      last_name: 'Doe',
      billing: { company: undefined, phone: '555-0100' },
      ...overrides,
    };
  }

  function wooProduct(overrides: Partial<Record<string, unknown>> = {}) {
    return {
      id: nextNumericId,
      sku: `BRICK-${runId}`,
      name: 'Standard Brick',
      description: '<p>A brick.</p>',
      price: '12.50',
      regular_price: '12.50',
      stock_quantity: 10,
      ...overrides,
    };
  }

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

  it('repeated customer sync does not create duplicate contacts', async () => {
    mockData.customers = [wooCustomer()];
    const first = await syncWooCommerce(siteId);
    const second = await syncWooCommerce(siteId);

    expect(first.customers).toBe(1);
    expect(second.customers).toBe(1);
    const contacts = await db.prisma.contact.findMany({ where: { email: `jane-${runId}@example.com` } });
    expect(contacts).toHaveLength(1);
  });

  it('repeated product sync does not create duplicates and does not re-emit a stock movement when nothing changed', async () => {
    const sku = `BRICK-${runId}`;
    mockData.products = [wooProduct({ stock_quantity: 10 })];
    const first = await syncWooCommerce(siteId);
    const second = await syncWooCommerce(siteId);

    expect(first.products).toBe(1);
    expect(second.products).toBe(1);
    const products = await db.prisma.product.findMany({ where: { sku } });
    expect(products).toHaveLength(1);
    const variants = await db.prisma.productVariant.findMany({ where: { productId: products[0].id } });
    expect(variants).toHaveLength(1);

    const level = await db.prisma.stockLevel.findUnique({
      where: { productVariantId_warehouseId: { productVariantId: variants[0].id, warehouseId } },
    });
    expect(level?.quantity).toBe(10);

    const movements = await db.prisma.stockMovement.findMany({ where: { productVariantId: variants[0].id } });
    expect(movements).toHaveLength(1); // only the first sync's delta (0 -> 10); the identical resync posted nothing
  });

  it('a product SKU rename in WooCommerce updates the existing CRM product instead of creating a duplicate', async () => {
    const id = nextNumericId;
    mockData.products = [wooProduct({ id, sku: `OLD-SKU-${runId}` })];
    await syncWooCommerce(siteId);

    mockData.products = [wooProduct({ id, sku: `NEW-SKU-${runId}` })];
    await syncWooCommerce(siteId);

    const bySource = await db.prisma.product.findMany({
      where: { externalSource: 'woocommerce', externalId: String(id) },
    });
    expect(bySource).toHaveLength(1);
    expect(bySource[0].sku).toBe(`NEW-SKU-${runId}`);
    const staleOldSku = await db.prisma.product.findUnique({ where: { sku: `OLD-SKU-${runId}` } });
    expect(staleOldSku).toBeNull();
  });

  it('repeated order sync does not create a duplicate SalesOrder', async () => {
    const order = wooOrder();
    mockData.orders = [order];
    const first = await syncWooCommerce(siteId);
    const second = await syncWooCommerce(siteId);

    expect(first.orders).toBe(1);
    expect(second.orders).toBe(1);
    const orders = await db.prisma.salesOrder.findMany({
      where: { externalSource: 'woocommerce', externalId: String(order.id) },
    });
    expect(orders).toHaveLength(1);
  });

  it('order line items map to the correct product/variant by SKU, and an unknown SKU produces a visible warning without dropping the line', async () => {
    const sku = `BRICK-${runId}`;
    mockData.products = [wooProduct({ sku, stock_quantity: 10 })];
    await syncWooCommerce(siteId); // seed the product/variant to map against

    const orderId = nextNumericId + 1;
    mockData.orders = [
      wooOrder({
        id: orderId,
        number: String(orderId),
        line_items: [
          { name: 'Standard Brick', quantity: 2, price: '9.00', sku, subtotal: '18.00' },
          { name: 'Mystery Item', quantity: 1, price: '4.00', sku: `DOES-NOT-EXIST-${runId}`, subtotal: '4.00' },
        ],
      }),
    ];
    const result = await syncWooCommerce(siteId);

    expect(result.warnings.some((w) => w.includes(`DOES-NOT-EXIST-${runId}`))).toBe(true);

    const order = await db.prisma.salesOrder.findFirstOrThrow({
      where: { externalSource: 'woocommerce', externalId: String(orderId) },
      include: { items: true },
    });
    const brickLine = order.items.find((i) => i.description === 'Standard Brick');
    const mysteryLine = order.items.find((i) => i.description === 'Mystery Item');
    expect(brickLine?.productId).toBeTruthy();
    expect(brickLine?.productVariantId).toBeTruthy();
    expect(mysteryLine).toBeTruthy(); // not discarded
    expect(mysteryLine?.productId).toBeNull();
    expect(Number(mysteryLine?.quantity)).toBe(1);
    expect(Number(mysteryLine?.unitPrice)).toBe(4);

    const logs = await db.prisma.automationLog.findMany({
      where: { entityType: 'WOOCOMMERCE_SYNC', entityId: String(orderId), success: false },
    });
    expect(logs.some((l) => l.message?.includes(`DOES-NOT-EXIST-${runId}`))).toBe(true);
  });

  it('financial fields are mapped correctly: subtotal from line items, tax/discount/total from the order, shipping as its own line', async () => {
    const sku = `BRICK-${runId}`;
    const orderId = nextNumericId;
    mockData.orders = [
      wooOrder({
        id: orderId,
        number: String(orderId),
        total: '25.00',
        total_tax: '2.00',
        discount_total: '3.00',
        shipping_total: '5.00',
        line_items: [{ name: 'Standard Brick', quantity: 2, price: '9.00', sku, subtotal: '18.00' }],
      }),
    ];
    await syncWooCommerce(siteId);

    const order = await db.prisma.salesOrder.findFirstOrThrow({
      where: { externalSource: 'woocommerce', externalId: String(orderId) },
      include: { items: true },
    });
    expect(Number(order.subtotal)).toBe(18);
    expect(Number(order.taxTotal)).toBe(2);
    expect(Number(order.discountTotal)).toBe(3);
    expect(Number(order.total)).toBe(25);

    const shippingLine = order.items.find((i) => i.description === 'Shipping');
    expect(shippingLine).toBeTruthy();
    expect(Number(shippingLine?.unitPrice)).toBe(5);
    expect(Number(shippingLine?.quantity)).toBe(1);
  });

  it('inventory sync posts a visible, ledgered stock movement instead of a silent overwrite, and stays accurate across changing quantities', async () => {
    const id = nextNumericId;
    const sku = `BRICK-${runId}`;
    mockData.products = [wooProduct({ id, sku, stock_quantity: 15 })];
    await syncWooCommerce(siteId);

    const variant = await db.prisma.productVariant.findUniqueOrThrow({ where: { sku: `${sku}-default` } });
    let level = await db.prisma.stockLevel.findUnique({
      where: { productVariantId_warehouseId: { productVariantId: variant.id, warehouseId } },
    });
    expect(level?.quantity).toBe(15);
    let movements = await db.prisma.stockMovement.findMany({
      where: { productVariantId: variant.id, referenceType: 'WOOCOMMERCE_SYNC' },
    });
    expect(movements).toHaveLength(1);
    expect(movements[0].type).toBe('IN');
    expect(movements[0].quantity).toBe(15);

    mockData.products = [wooProduct({ id, sku, stock_quantity: 8 })];
    await syncWooCommerce(siteId);

    level = await db.prisma.stockLevel.findUnique({
      where: { productVariantId_warehouseId: { productVariantId: variant.id, warehouseId } },
    });
    expect(level?.quantity).toBe(8);
    movements = await db.prisma.stockMovement.findMany({
      where: { productVariantId: variant.id, referenceType: 'WOOCOMMERCE_SYNC' },
      orderBy: { createdAt: 'asc' },
    });
    expect(movements).toHaveLength(2);
    expect(movements[1].type).toBe('OUT');
    expect(movements[1].quantity).toBe(7);
  });

  it('two concurrent syncs of the same site: one proceeds, the other is rejected rather than racing', async () => {
    const order = wooOrder();
    mockData.orders = [order];

    const results = await Promise.allSettled([syncWooCommerce(siteId), syncWooCommerce(siteId)]);

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason?.message).toMatch(/already in progress/);

    const orders = await db.prisma.salesOrder.findMany({
      where: { externalSource: 'woocommerce', externalId: String(order.id) },
    });
    expect(orders).toHaveLength(1);
  });
});
