import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { TestDb } from './test-db';
import { startTestDb } from './test-db';

/**
 * SYSTEM_AUDIT.md E6: checkLowStock() was rewritten from "load every
 * StockLevel row, filter quantity <= reorderPoint in JS" to a single raw
 * SQL join that filters at the database level (src/lib/automations/
 * engine.ts). These tests prove the rewrite preserves the exact same
 * business behavior — which rows count as "low," which get skipped, and
 * that a Task is created for each flagged row — not just that the query
 * runs without error.
 */
describe('checkLowStock (DB-side filtering)', () => {
  let db: TestDb;
  let checkLowStock: typeof import('../src/lib/automations/engine')['checkLowStock'];

  beforeAll(async () => {
    db = await startTestDb();
    process.env.DATABASE_URL = db.url;
    const mod = await import('../src/lib/automations/engine');
    checkLowStock = mod.checkLowStock;
  }, 60000);

  afterAll(async () => {
    await db.stop();
  });

  function id() {
    return Math.random().toString(36).slice(2);
  }

  async function makeWarehouse() {
    return db.prisma.warehouse.create({ data: { name: `WH-${id()}` } });
  }

  async function makeVariant(opts: { trackInventory: boolean; reorderPoint: number }) {
    const product = await db.prisma.product.create({
      data: { sku: `SKU-${id()}`, name: `Product ${id()}`, trackInventory: opts.trackInventory, reorderPoint: opts.reorderPoint },
    });
    const variant = await db.prisma.productVariant.create({ data: { productId: product.id, sku: `${product.sku}-v`, name: 'Default' } });
    return { product, variant };
  }

  it('flags a tracked product at or below its reorder point and creates a Task for it', async () => {
    const warehouse = await makeWarehouse();
    const { product, variant } = await makeVariant({ trackInventory: true, reorderPoint: 10 });
    await db.prisma.stockLevel.create({ data: { productVariantId: variant.id, warehouseId: warehouse.id, quantity: 5 } });

    const flagged = await checkLowStock();
    expect(flagged).toBeGreaterThanOrEqual(1);

    const task = await db.prisma.task.findFirst({ where: { relatedType: 'PRODUCT', relatedId: product.id } });
    expect(task).not.toBeNull();
    expect(task!.title).toContain('Low stock');
    expect(task!.description).toContain('5 units left');
  });

  it('does not flag a tracked product above its reorder point', async () => {
    const warehouse = await makeWarehouse();
    const { product, variant } = await makeVariant({ trackInventory: true, reorderPoint: 10 });
    await db.prisma.stockLevel.create({ data: { productVariantId: variant.id, warehouseId: warehouse.id, quantity: 50 } });

    await checkLowStock();
    const task = await db.prisma.task.findFirst({ where: { relatedType: 'PRODUCT', relatedId: product.id } });
    expect(task).toBeNull();
  });

  it('does not flag a product with trackInventory=false, even at zero stock', async () => {
    const warehouse = await makeWarehouse();
    const { product, variant } = await makeVariant({ trackInventory: false, reorderPoint: 10 });
    await db.prisma.stockLevel.create({ data: { productVariantId: variant.id, warehouseId: warehouse.id, quantity: 0 } });

    await checkLowStock();
    const task = await db.prisma.task.findFirst({ where: { relatedType: 'PRODUCT', relatedId: product.id } });
    expect(task).toBeNull();
  });

  it('the boundary is inclusive: quantity exactly equal to the reorder point is flagged', async () => {
    const warehouse = await makeWarehouse();
    const { product, variant } = await makeVariant({ trackInventory: true, reorderPoint: 10 });
    await db.prisma.stockLevel.create({ data: { productVariantId: variant.id, warehouseId: warehouse.id, quantity: 10 } });

    await checkLowStock();
    const task = await db.prisma.task.findFirst({ where: { relatedType: 'PRODUCT', relatedId: product.id } });
    expect(task).not.toBeNull();
  });

  it('a running checkLowStock a second time does not duplicate the Task for a still-low product (ensureTask dedupe)', async () => {
    const warehouse = await makeWarehouse();
    const { product, variant } = await makeVariant({ trackInventory: true, reorderPoint: 10 });
    await db.prisma.stockLevel.create({ data: { productVariantId: variant.id, warehouseId: warehouse.id, quantity: 1 } });

    await checkLowStock();
    await checkLowStock();

    const tasks = await db.prisma.task.findMany({ where: { relatedType: 'PRODUCT', relatedId: product.id } });
    expect(tasks).toHaveLength(1);
  });
});
