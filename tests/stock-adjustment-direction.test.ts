import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { TestDb } from './test-db';
import { startTestDb } from './test-db';

/**
 * docs/FINAL_SYSTEM_AUDIT.md #3 (HIGH): recordStockMovement treated every
 * non-OUT type (including ADJUSTMENT) as a positive delta, so a downward
 * stocktake correction recorded as "Adjustment" silently ADDED stock
 * instead of subtracting it. Fixed via an explicit `direction` param that's
 * required for ADJUSTMENT and ignored (as before) for IN/OUT.
 */
describe('recordStockMovement ADJUSTMENT direction', () => {
  let db: TestDb;
  let recordStockMovement: typeof import('../src/lib/automations/stock')['recordStockMovement'];

  beforeAll(async () => {
    db = await startTestDb();
    process.env.DATABASE_URL = db.url;
    const mod = await import('../src/lib/automations/stock');
    recordStockMovement = mod.recordStockMovement;
  }, 60000);

  afterAll(async () => {
    await db.stop();
  });

  function id() {
    return Math.random().toString(36).slice(2);
  }

  async function seedVariantWithStock(quantity: number) {
    const warehouse = await db.prisma.warehouse.create({ data: { name: `WH-${id()}` } });
    const product = await db.prisma.product.create({ data: { sku: `SKU-${id()}`, name: `Product ${id()}` } });
    const variant = await db.prisma.productVariant.create({
      data: { productId: product.id, sku: `${product.sku}-v`, name: 'Default' },
    });
    await db.prisma.stockLevel.create({ data: { productVariantId: variant.id, warehouseId: warehouse.id, quantity } });
    return { variant, warehouse };
  }

  async function currentQuantity(variantId: string, warehouseId: string) {
    const level = await db.prisma.stockLevel.findUnique({
      where: { productVariantId_warehouseId: { productVariantId: variantId, warehouseId } },
    });
    return level?.quantity ?? 0;
  }

  it('THE FIX: an ADJUSTMENT with direction DECREASE actually decreases stock', async () => {
    const { variant, warehouse } = await seedVariantWithStock(50);
    await recordStockMovement({
      productVariantId: variant.id,
      warehouseId: warehouse.id,
      type: 'ADJUSTMENT',
      quantity: 5,
      direction: 'DECREASE',
    });
    expect(await currentQuantity(variant.id, warehouse.id)).toBe(45);
  });

  it('an ADJUSTMENT with direction INCREASE increases stock', async () => {
    const { variant, warehouse } = await seedVariantWithStock(50);
    await recordStockMovement({
      productVariantId: variant.id,
      warehouseId: warehouse.id,
      type: 'ADJUSTMENT',
      quantity: 5,
      direction: 'INCREASE',
    });
    expect(await currentQuantity(variant.id, warehouse.id)).toBe(55);
  });

  it('an ADJUSTMENT with no direction specified defaults to INCREASE (pre-existing-caller compatibility)', async () => {
    const { variant, warehouse } = await seedVariantWithStock(50);
    await recordStockMovement({
      productVariantId: variant.id,
      warehouseId: warehouse.id,
      type: 'ADJUSTMENT',
      quantity: 5,
    });
    expect(await currentQuantity(variant.id, warehouse.id)).toBe(55);
  });

  it('a DECREASE adjustment is floored at zero, never negative', async () => {
    const { variant, warehouse } = await seedVariantWithStock(3);
    await recordStockMovement({
      productVariantId: variant.id,
      warehouseId: warehouse.id,
      type: 'ADJUSTMENT',
      quantity: 10,
      direction: 'DECREASE',
    });
    expect(await currentQuantity(variant.id, warehouse.id)).toBe(0);
  });

  it('IN and OUT are unaffected by the direction param (backward compatible)', async () => {
    const { variant, warehouse } = await seedVariantWithStock(50);
    await recordStockMovement({ productVariantId: variant.id, warehouseId: warehouse.id, type: 'IN', quantity: 10 });
    expect(await currentQuantity(variant.id, warehouse.id)).toBe(60);
    await recordStockMovement({ productVariantId: variant.id, warehouseId: warehouse.id, type: 'OUT', quantity: 20 });
    expect(await currentQuantity(variant.id, warehouse.id)).toBe(40);
  });

  it('the StockMovement ledger stores quantity as a positive magnitude regardless of direction', async () => {
    const { variant, warehouse } = await seedVariantWithStock(50);
    await recordStockMovement({
      productVariantId: variant.id,
      warehouseId: warehouse.id,
      type: 'ADJUSTMENT',
      quantity: 5,
      direction: 'DECREASE',
    });
    const movement = await db.prisma.stockMovement.findFirst({
      where: { productVariantId: variant.id, type: 'ADJUSTMENT' },
    });
    expect(movement?.quantity).toBe(5);
  });
});
