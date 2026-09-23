import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { TestDb } from './test-db';
import { startTestDb } from './test-db';

/** Item 3 (Phase 0): a sales-order status change and its inventory effect
 * must be applied atomically, so that two concurrent requests for the same
 * transition (a double-click, a retried request) can never both deduct or
 * return stock. This is the exact race described as C1 in
 * docs/SYSTEM_AUDIT.md. */
describe('Transaction-safe sales-order status/inventory changes', () => {
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

  /** A fresh DRAFT order (quantity 5) against 20 units of on-hand stock,
   * recreated before every test so tests don't interact. */
  async function seedOrder(quantity = 5) {
    const product = await db.prisma.product.create({
      data: { sku: `SKU-${Math.random().toString(36).slice(2)}`, name: 'Test brick', trackInventory: true },
    });
    const variant = await db.prisma.productVariant.create({
      data: { productId: product.id, sku: `${product.sku}-v`, name: 'Default' },
    });
    variantId = variant.id;
    await db.prisma.stockLevel.create({ data: { productVariantId: variant.id, warehouseId, quantity: 20 } });

    const order = await db.prisma.salesOrder.create({
      data: {
        number: `SO-TEST-${Math.random().toString(36).slice(2)}`,
        status: 'DRAFT',
        total: 100,
        items: { create: [{ productVariantId: variant.id, description: 'Test brick', quantity, unitPrice: 20 }] },
      },
    });
    return order;
  }

  beforeEach(async () => {
    // Only one warehouse may be `isDefault: true` at a time — the code
    // under test looks up "the" default warehouse, so leaving a previous
    // test's default warehouse around would make this test's stock land in
    // the wrong warehouse instead of failing loudly.
    await db.prisma.warehouse.updateMany({ where: { isDefault: true }, data: { isDefault: false } });
    const wh = await db.prisma.warehouse.create({ data: { name: `WH-${Math.random()}`, isDefault: true } });
    warehouseId = wh.id;
  });

  it('CONFIRMED deducts stock exactly once', async () => {
    const order = await seedOrder(5);
    const result = await transitionSalesOrderStatus(order.id, 'CONFIRMED');
    expect(result.changed).toBe(true);
    expect(result.order.status).toBe('CONFIRMED');

    const movements = await db.prisma.stockMovement.findMany({ where: { referenceType: 'SALES_ORDER', referenceId: order.id } });
    expect(movements).toHaveLength(1);
    expect(movements[0].type).toBe('OUT');
    expect(movements[0].quantity).toBe(5);

    const level = await db.prisma.stockLevel.findUnique({
      where: { productVariantId_warehouseId: { productVariantId: variantId, warehouseId } },
    });
    expect(level?.quantity).toBe(15); // 20 - 5
  });

  it('CANCELLED after CONFIRMED returns the stock', async () => {
    const order = await seedOrder(5);
    await transitionSalesOrderStatus(order.id, 'CONFIRMED');
    const result = await transitionSalesOrderStatus(order.id, 'CANCELLED');
    expect(result.changed).toBe(true);

    const level = await db.prisma.stockLevel.findUnique({
      where: { productVariantId_warehouseId: { productVariantId: variantId, warehouseId } },
    });
    expect(level?.quantity).toBe(20); // back to the starting quantity

    const movements = await db.prisma.stockMovement.findMany({ where: { referenceType: 'SALES_ORDER', referenceId: order.id } });
    expect(movements).toHaveLength(2); // one OUT, one IN
  });

  it('resending the same status is a harmless no-op (no second movement)', async () => {
    const order = await seedOrder(5);
    await transitionSalesOrderStatus(order.id, 'CONFIRMED');
    const second = await transitionSalesOrderStatus(order.id, 'CONFIRMED');
    expect(second.changed).toBe(false);

    const movements = await db.prisma.stockMovement.findMany({ where: { referenceType: 'SALES_ORDER', referenceId: order.id } });
    expect(movements).toHaveLength(1);
  });

  it('THE FIX: two concurrent CONFIRMED requests never both deduct stock', async () => {
    const order = await seedOrder(5);

    // Simulate the real-world race: a double-click or a retried request
    // firing the exact same transition at (almost) the same instant.
    const results = await Promise.allSettled([
      transitionSalesOrderStatus(order.id, 'CONFIRMED'),
      transitionSalesOrderStatus(order.id, 'CONFIRMED'),
    ]);

    const fulfilled = results.filter((r) => r.status === 'fulfilled') as PromiseFulfilledResult<
      Awaited<ReturnType<typeof transitionSalesOrderStatus>>
    >[];
    const rejected = results.filter((r) => r.status === 'rejected');

    // Every settled outcome must be either "I made the change" (changed
    // true, at most once) or "someone else already did / conflict" — never
    // a silent double-apply.
    const changedCount = fulfilled.filter((r) => r.value.changed).length;
    expect(changedCount).toBeLessThanOrEqual(1);
    for (const r of rejected) {
      expect(r.reason).toBeInstanceOf(SalesOrderStatusConflictError);
    }

    // The real proof: exactly one stock-out movement, not two, and the
    // level reflects a single deduction regardless of which request "won".
    const movements = await db.prisma.stockMovement.findMany({ where: { referenceType: 'SALES_ORDER', referenceId: order.id } });
    expect(movements).toHaveLength(1);
    expect(movements[0].quantity).toBe(5);

    const level = await db.prisma.stockLevel.findUnique({
      where: { productVariantId_warehouseId: { productVariantId: variantId, warehouseId } },
    });
    expect(level?.quantity).toBe(15);

    const finalOrder = await db.prisma.salesOrder.findUniqueOrThrow({ where: { id: order.id } });
    expect(finalOrder.status).toBe('CONFIRMED');
  });

  it('resending an already-current status is a no-op, even later in the lifecycle', async () => {
    const order = await seedOrder(5);
    await transitionSalesOrderStatus(order.id, 'CONFIRMED');
    await transitionSalesOrderStatus(order.id, 'SHIPPED');
    const movementsAfterShipped = await db.prisma.stockMovement.findMany({
      where: { referenceType: 'SALES_ORDER', referenceId: order.id },
    });
    const countAfterShipped = movementsAfterShipped.length;

    // Something still holding the old "SHIPPED" status resends it — should
    // be a harmless no-op (already the current status), not another effect.
    const result = await transitionSalesOrderStatus(order.id, 'SHIPPED');
    expect(result.changed).toBe(false);

    const movements = await db.prisma.stockMovement.findMany({ where: { referenceType: 'SALES_ORDER', referenceId: order.id } });
    expect(movements).toHaveLength(countAfterShipped);
  });
});
