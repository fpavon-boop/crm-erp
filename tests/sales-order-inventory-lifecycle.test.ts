import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { TestDb } from './test-db';
import { startTestDb } from './test-db';

/**
 * Inventory lifecycle correction (Phase 0 follow-up): a sales order must
 * deduct stock exactly once, at the first stock-consuming status it
 * reaches, and restore it exactly once (only if it was deducted) on
 * cancellation. This was violated: CONFIRMED -> SHIPPED created a SECOND
 * StockMovement OUT for the same order. See docs/INVENTORY_RULES.md.
 *
 * Every test here checks both StockLevel.quantity and the StockMovement
 * ledger (count and type), as required.
 */
describe('Sales order inventory lifecycle', () => {
  let db: TestDb;
  let transitionSalesOrderStatus: typeof import('../src/lib/sales-orders')['transitionSalesOrderStatus'];
  let SalesOrderStatusConflictError: typeof import('../src/lib/sales-orders')['SalesOrderStatusConflictError'];

  beforeAll(async () => {
    db = await startTestDb();
    process.env.DATABASE_URL = db.url;
    const mod = await import('../src/lib/sales-orders');
    transitionSalesOrderStatus = mod.transitionSalesOrderStatus;
    SalesOrderStatusConflictError = mod.SalesOrderStatusConflictError;
  }, 60000);

  afterAll(async () => {
    await db.stop();
  });

  let warehouseId: string;
  let variantId: string;
  const STARTING_STOCK = 20;
  const ORDER_QTY = 5;

  async function seedOrder(quantity = ORDER_QTY) {
    const product = await db.prisma.product.create({
      data: { sku: `SKU-${Math.random().toString(36).slice(2)}`, name: 'Test brick', trackInventory: true },
    });
    const variant = await db.prisma.productVariant.create({
      data: { productId: product.id, sku: `${product.sku}-v`, name: 'Default' },
    });
    variantId = variant.id;
    await db.prisma.stockLevel.create({ data: { productVariantId: variant.id, warehouseId, quantity: STARTING_STOCK } });

    return db.prisma.salesOrder.create({
      data: {
        number: `SO-LC-${Math.random().toString(36).slice(2)}`,
        status: 'DRAFT',
        total: 100,
        items: { create: [{ productVariantId: variant.id, description: 'Test brick', quantity, unitPrice: 20 }] },
      },
    });
  }

  async function level() {
    const l = await db.prisma.stockLevel.findUnique({
      where: { productVariantId_warehouseId: { productVariantId: variantId, warehouseId } },
    });
    return l?.quantity ?? null;
  }

  async function movements(orderId: string) {
    return db.prisma.stockMovement.findMany({
      where: { referenceType: 'SALES_ORDER', referenceId: orderId },
      orderBy: { createdAt: 'asc' },
    });
  }

  beforeEach(async () => {
    // Only one warehouse may be `isDefault: true` at a time (the code under
    // test looks up "the" default warehouse) — see the note in
    // sales-order-status-transition.test.ts for why this matters.
    await db.prisma.warehouse.updateMany({ where: { isDefault: true }, data: { isDefault: false } });
    const wh = await db.prisma.warehouse.create({ data: { name: `WH-${Math.random()}`, isDefault: true } });
    warehouseId = wh.id;
  });

  it('DRAFT -> CONFIRMED: deducts stock exactly once', async () => {
    const order = await seedOrder();
    const result = await transitionSalesOrderStatus(order.id, 'CONFIRMED');
    expect(result.changed).toBe(true);
    expect(result.order.status).toBe('CONFIRMED');

    const mv = await movements(order.id);
    expect(mv).toHaveLength(1);
    expect(mv[0].type).toBe('OUT');
    expect(mv[0].quantity).toBe(ORDER_QTY);
    expect(await level()).toBe(STARTING_STOCK - ORDER_QTY);
  });

  it('CONFIRMED -> CONFIRMED (resend): idempotent, no second movement', async () => {
    const order = await seedOrder();
    await transitionSalesOrderStatus(order.id, 'CONFIRMED');
    const second = await transitionSalesOrderStatus(order.id, 'CONFIRMED');

    expect(second.changed).toBe(false);
    const mv = await movements(order.id);
    expect(mv).toHaveLength(1);
    expect(mv[0].type).toBe('OUT');
    expect(await level()).toBe(STARTING_STOCK - ORDER_QTY);
  });

  it('THE BUG: CONFIRMED -> SHIPPED must NOT deduct stock a second time', async () => {
    const order = await seedOrder();
    await transitionSalesOrderStatus(order.id, 'CONFIRMED');
    const shipped = await transitionSalesOrderStatus(order.id, 'SHIPPED');

    expect(shipped.changed).toBe(true); // the status DID change...
    expect(shipped.order.status).toBe('SHIPPED');

    // ...but inventory must not have moved a second time.
    const mv = await movements(order.id);
    expect(mv).toHaveLength(1);
    expect(mv[0].type).toBe('OUT');
    expect(mv[0].quantity).toBe(ORDER_QTY);
    expect(await level()).toBe(STARTING_STOCK - ORDER_QTY);
  });

  it('SHIPPED -> SHIPPED (resend): idempotent, still only one movement total', async () => {
    const order = await seedOrder();
    await transitionSalesOrderStatus(order.id, 'CONFIRMED');
    await transitionSalesOrderStatus(order.id, 'SHIPPED');
    const resend = await transitionSalesOrderStatus(order.id, 'SHIPPED');

    expect(resend.changed).toBe(false);
    const mv = await movements(order.id);
    expect(mv).toHaveLength(1);
    expect(await level()).toBe(STARTING_STOCK - ORDER_QTY);
  });

  it('a direct DRAFT -> SHIPPED jump (bypassing CONFIRMED) still deducts exactly once', async () => {
    const order = await seedOrder();
    const result = await transitionSalesOrderStatus(order.id, 'SHIPPED');
    expect(result.changed).toBe(true);

    const mv = await movements(order.id);
    expect(mv).toHaveLength(1);
    expect(mv[0].type).toBe('OUT');
    expect(await level()).toBe(STARTING_STOCK - ORDER_QTY);
  });

  it('CONFIRMED -> CANCELLED: restores the deducted stock exactly once', async () => {
    const order = await seedOrder();
    await transitionSalesOrderStatus(order.id, 'CONFIRMED');
    const cancelled = await transitionSalesOrderStatus(order.id, 'CANCELLED');

    expect(cancelled.changed).toBe(true);
    const mv = await movements(order.id);
    expect(mv).toHaveLength(2);
    expect(mv[0].type).toBe('OUT');
    expect(mv[1].type).toBe('IN');
    expect(await level()).toBe(STARTING_STOCK); // back to the starting quantity
  });

  it('SHIPPED -> CANCELLED: still restores exactly once (stock was deducted at CONFIRMED, not SHIPPED)', async () => {
    const order = await seedOrder();
    await transitionSalesOrderStatus(order.id, 'CONFIRMED');
    await transitionSalesOrderStatus(order.id, 'SHIPPED');
    const cancelled = await transitionSalesOrderStatus(order.id, 'CANCELLED');

    expect(cancelled.changed).toBe(true);
    const mv = await movements(order.id);
    // Exactly one OUT (from CONFIRMED; SHIPPED correctly added none) and
    // exactly one IN (from CANCELLED) — three movements would mean the
    // SHIPPED bug is back.
    expect(mv).toHaveLength(2);
    expect(mv.filter((m) => m.type === 'OUT')).toHaveLength(1);
    expect(mv.filter((m) => m.type === 'IN')).toHaveLength(1);
    expect(await level()).toBe(STARTING_STOCK);
  });

  it('DRAFT -> CANCELLED: nothing was ever deducted, so nothing is restored (no phantom IN movement)', async () => {
    const order = await seedOrder();
    const cancelled = await transitionSalesOrderStatus(order.id, 'CANCELLED');

    expect(cancelled.changed).toBe(true);
    const mv = await movements(order.id);
    expect(mv).toHaveLength(0);
    expect(await level()).toBe(STARTING_STOCK); // untouched
  });

  it('CANCELLED -> CANCELLED (resend): idempotent, does not restore twice', async () => {
    const order = await seedOrder();
    await transitionSalesOrderStatus(order.id, 'CONFIRMED');
    await transitionSalesOrderStatus(order.id, 'CANCELLED');
    const resend = await transitionSalesOrderStatus(order.id, 'CANCELLED');

    expect(resend.changed).toBe(false);
    const mv = await movements(order.id);
    expect(mv).toHaveLength(2); // still just the original OUT + IN pair
    expect(await level()).toBe(STARTING_STOCK);
  });

  it('retry after timeout: a caller that resends the SAME transition (e.g. after a client-side timeout, unaware the first attempt actually succeeded) is a safe no-op', async () => {
    const order = await seedOrder();
    const first = await transitionSalesOrderStatus(order.id, 'CONFIRMED');
    expect(first.changed).toBe(true);

    // Simulates a client that timed out waiting for the first response and
    // retries the identical request, not knowing it already succeeded.
    const retry = await transitionSalesOrderStatus(order.id, 'CONFIRMED');
    expect(retry.changed).toBe(false);

    const mv = await movements(order.id);
    expect(mv).toHaveLength(1);
    expect(await level()).toBe(STARTING_STOCK - ORDER_QTY);
  });

  it('CONCURRENT CONFIRMED requests: stock is deducted exactly once (verifies StockLevel AND StockMovement)', async () => {
    const order = await seedOrder();

    const results = await Promise.allSettled([
      transitionSalesOrderStatus(order.id, 'CONFIRMED'),
      transitionSalesOrderStatus(order.id, 'CONFIRMED'),
    ]);

    const fulfilled = results.filter((r) => r.status === 'fulfilled') as PromiseFulfilledResult<
      Awaited<ReturnType<typeof transitionSalesOrderStatus>>
    >[];
    expect(fulfilled.filter((r) => r.value.changed).length).toBeLessThanOrEqual(1);
    for (const r of results) {
      if (r.status === 'rejected') expect(r.reason).toBeInstanceOf(SalesOrderStatusConflictError);
    }

    const mv = await movements(order.id);
    expect(mv).toHaveLength(1);
    expect(mv[0].type).toBe('OUT');
    expect(await level()).toBe(STARTING_STOCK - ORDER_QTY);

    const finalOrder = await db.prisma.salesOrder.findUniqueOrThrow({ where: { id: order.id } });
    expect(finalOrder.status).toBe('CONFIRMED');
  });

  it('CONCURRENT SHIPPED requests (order already CONFIRMED): no additional deduction, exactly one status change wins', async () => {
    const order = await seedOrder();
    await transitionSalesOrderStatus(order.id, 'CONFIRMED');

    const results = await Promise.allSettled([
      transitionSalesOrderStatus(order.id, 'SHIPPED'),
      transitionSalesOrderStatus(order.id, 'SHIPPED'),
    ]);

    const fulfilled = results.filter((r) => r.status === 'fulfilled') as PromiseFulfilledResult<
      Awaited<ReturnType<typeof transitionSalesOrderStatus>>
    >[];
    expect(fulfilled.filter((r) => r.value.changed).length).toBeLessThanOrEqual(1);
    for (const r of results) {
      if (r.status === 'rejected') expect(r.reason).toBeInstanceOf(SalesOrderStatusConflictError);
    }

    // Still exactly the one OUT movement from CONFIRMED — SHIPPED (even
    // fired twice, concurrently) must add nothing.
    const mv = await movements(order.id);
    expect(mv).toHaveLength(1);
    expect(mv[0].type).toBe('OUT');
    expect(await level()).toBe(STARTING_STOCK - ORDER_QTY);

    const finalOrder = await db.prisma.salesOrder.findUniqueOrThrow({ where: { id: order.id } });
    expect(finalOrder.status).toBe('SHIPPED');
  });

  it('duplicate transition request fired back-to-back (not concurrently): still exactly one movement', async () => {
    const order = await seedOrder();
    await transitionSalesOrderStatus(order.id, 'CONFIRMED');
    await transitionSalesOrderStatus(order.id, 'CONFIRMED');
    await transitionSalesOrderStatus(order.id, 'CONFIRMED');

    const mv = await movements(order.id);
    expect(mv).toHaveLength(1);
    expect(await level()).toBe(STARTING_STOCK - ORDER_QTY);
  });
});
