import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import type { TestDb } from './test-db';
import { startTestDb } from './test-db';

type Safeguards = typeof import('../src/marketing/ai/safeguards');

/**
 * Marketing Phase 4: read-only safeguard engine
 * (src/marketing/ai/safeguards.ts, architecture doc §3).
 *
 * Proves stock edge cases (thresholds, draft-order deduction, inactive
 * variants/warehouses, untracked inventory), margin math (exact-threshold,
 * purchase-history vs manual cost, unknown cost, invalid inputs), top-seller
 * ranking, and that none of it writes to the database.
 */
describe('marketing safeguards (read-only)', () => {
  let db: TestDb;
  let sg: Safeguards;

  beforeAll(async () => {
    db = await startTestDb();
    process.env.DATABASE_URL = db.url;
    sg = await import('../src/marketing/ai/safeguards');
  }, 60000);

  afterAll(async () => {
    await db.stop();
  });

  const uid = () => Math.random().toString(36).slice(2, 10);

  async function makeProduct(opts: {
    price?: number;
    cost?: number;
    stock?: number[];
    trackInventory?: boolean;
    active?: boolean;
    reorderPoint?: number;
  } = {}) {
    const product = await db.prisma.product.create({
      data: {
        sku: `SKU-${uid()}`,
        name: `Oven ${uid()}`,
        price: opts.price ?? 100,
        cost: opts.cost ?? 0,
        trackInventory: opts.trackInventory ?? true,
        active: opts.active ?? true,
        reorderPoint: opts.reorderPoint ?? 0,
      },
    });
    const variant = await db.prisma.productVariant.create({ data: { productId: product.id, sku: `${product.sku}-v` } });
    for (const qty of opts.stock ?? []) {
      const wh = await db.prisma.warehouse.create({ data: { name: `WH-${uid()}` } });
      await db.prisma.stockLevel.create({ data: { productVariantId: variant.id, warehouseId: wh.id, quantity: qty } });
    }
    return { product, variant };
  }

  async function makeOrder(
    productId: string,
    quantity: number,
    status: 'DRAFT' | 'CONFIRMED' | 'SHIPPED' | 'DELIVERED' | 'CANCELLED' | 'REFUNDED',
    extra: { unitPrice?: number; createdAt?: Date } = {}
  ) {
    return db.prisma.salesOrder.create({
      data: {
        number: `SO-${uid()}`,
        status,
        createdAt: extra.createdAt,
        items: { create: [{ productId, description: 'line', quantity, unitPrice: extra.unitPrice ?? 100 }] },
      },
    });
  }

  async function receive(productId: string, lines: Array<{ qty: number; unitCost: number }>) {
    const po = await db.prisma.purchaseOrder.create({ data: { number: `PO-${uid()}`, status: 'RECEIVED' } });
    const receipt = await db.prisma.goodsReceipt.create({ data: { purchaseOrderId: po.id } });
    for (const l of lines) {
      const poi = await db.prisma.purchaseOrderItem.create({
        data: { purchaseOrderId: po.id, productId, description: 'buy', quantity: l.qty, unitCost: l.unitCost },
      });
      await db.prisma.goodsReceiptItem.create({
        data: { goodsReceiptId: receipt.id, purchaseOrderItemId: poi.id, productId, quantity: l.qty },
      });
    }
  }

  // ---------------------------------------------------------------------------
  describe('checkInventoryStatus', () => {
    it('passes when available is exactly min + buffer (3)', async () => {
      const { product } = await makeProduct({ stock: [3] });
      const r = await sg.checkInventoryStatus(product.id);
      expect(r).toMatchObject({ verdict: 'PASS', onHand: 3, draftCommitted: 0, available: 3, requiredMinimum: 3 });
    });

    it('blocks one unit below the threshold', async () => {
      const { product } = await makeProduct({ stock: [2] });
      const r = await sg.checkInventoryStatus(product.id);
      expect(r.verdict).toBe('BLOCK');
      expect(r.issues.map((i) => i.code)).toEqual(['INSUFFICIENT_STOCK']);
    });

    it('sums stock across warehouses', async () => {
      const { product } = await makeProduct({ stock: [1, 1, 1] });
      expect((await sg.checkInventoryStatus(product.id)).available).toBe(3);
    });

    it('deducts DRAFT order quantities from available stock', async () => {
      const { product } = await makeProduct({ stock: [5] });
      await makeOrder(product.id, 2, 'DRAFT');
      await makeOrder(product.id, 1, 'DRAFT');
      const r = await sg.checkInventoryStatus(product.id);
      expect(r).toMatchObject({ onHand: 5, draftCommitted: 3, available: 2, verdict: 'BLOCK' });
    });

    it('does not double-deduct non-draft orders (already reflected in StockLevel)', async () => {
      const { product } = await makeProduct({ stock: [5] });
      for (const s of ['CONFIRMED', 'SHIPPED', 'DELIVERED', 'CANCELLED', 'REFUNDED'] as const) {
        await makeOrder(product.id, 4, s);
      }
      expect(await sg.checkInventoryStatus(product.id)).toMatchObject({ draftCommitted: 0, available: 5, verdict: 'PASS' });
    });

    it('reports negative availability when drafts exceed stock', async () => {
      const { product } = await makeProduct({ stock: [1] });
      await makeOrder(product.id, 4, 'DRAFT');
      expect(await sg.checkInventoryStatus(product.id)).toMatchObject({ available: -3, verdict: 'BLOCK' });
    });

    it('ignores stock in inactive warehouses and on inactive variants', async () => {
      const { product, variant } = await makeProduct({ stock: [3] });
      const closed = await db.prisma.warehouse.create({ data: { name: `WH-${uid()}`, active: false } });
      await db.prisma.stockLevel.create({ data: { productVariantId: variant.id, warehouseId: closed.id, quantity: 50 } });
      const retired = await db.prisma.productVariant.create({
        data: { productId: product.id, sku: `${product.sku}-old`, active: false },
      });
      const wh = await db.prisma.warehouse.create({ data: { name: `WH-${uid()}` } });
      await db.prisma.stockLevel.create({ data: { productVariantId: retired.id, warehouseId: wh.id, quantity: 50 } });
      expect((await sg.checkInventoryStatus(product.id)).onHand).toBe(3);
    });

    it('blocks a product with no stock rows at all', async () => {
      const { product } = await makeProduct();
      expect(await sg.checkInventoryStatus(product.id)).toMatchObject({ onHand: 0, verdict: 'BLOCK' });
    });

    it('warns (not blocks) when at or below reorder point but above the minimum', async () => {
      const { product } = await makeProduct({ stock: [5], reorderPoint: 5 });
      const r = await sg.checkInventoryStatus(product.id);
      expect(r.verdict).toBe('WARN');
      expect(r.issues[0].code).toBe('AT_OR_BELOW_REORDER_POINT');
    });

    it('warns when inventory is not tracked', async () => {
      const { product } = await makeProduct({ trackInventory: false });
      const r = await sg.checkInventoryStatus(product.id);
      expect(r.verdict).toBe('WARN');
      expect(r.issues[0].code).toBe('INVENTORY_NOT_TRACKED');
    });

    it('blocks inactive and missing products', async () => {
      const { product } = await makeProduct({ stock: [10], active: false });
      expect((await sg.checkInventoryStatus(product.id)).issues.map((i) => i.code)).toContain('PRODUCT_INACTIVE');
      expect(await sg.checkInventoryStatus('does-not-exist')).toMatchObject({
        verdict: 'BLOCK',
        issues: [{ code: 'PRODUCT_NOT_FOUND' }],
      });
    });

    it('honours a custom policy', async () => {
      const { product } = await makeProduct({ stock: [3] });
      const r = await sg.checkInventoryStatus(product.id, { minMarginPct: 25, minPromotableStock: 5, safetyBufferUnits: 2 });
      expect(r).toMatchObject({ requiredMinimum: 7, verdict: 'BLOCK' });
    });
  });

  // ---------------------------------------------------------------------------
  describe('evaluateMargin (pure math)', () => {
    const cost = (unitCost: number | null, source: 'purchase_history' | 'standard_cost' | 'unknown' = 'purchase_history') => ({
      unitCost,
      source,
    });

    it('passes at exactly the 25% threshold', () => {
      // 100 * 0.8 = 80 promo; cost 60 → margin 20/80 = 25%
      const r = sg.evaluateMargin({ productId: 'p', listPrice: 100, discountPct: 20, cost: cost(60), minMarginPct: 25 });
      expect(r).toMatchObject({ verdict: 'PASS', promoPrice: 80, marginPct: 25, maxDiscountPct: 20 });
    });

    it('blocks just past the threshold', () => {
      const r = sg.evaluateMargin({ productId: 'p', listPrice: 100, discountPct: 20.5, cost: cost(60), minMarginPct: 25 });
      expect(r.verdict).toBe('BLOCK');
      expect(r.issues.map((i) => i.code)).toEqual(['MARGIN_BELOW_MINIMUM']);
      expect(r.marginPct).toBeCloseTo(24.53, 2);
    });

    it('handles a zero discount and a negative margin', () => {
      expect(sg.evaluateMargin({ productId: 'p', listPrice: 100, discountPct: 0, cost: cost(40), minMarginPct: 25 })).toMatchObject({
        verdict: 'PASS',
        marginPct: 60,
      });
      const loss = sg.evaluateMargin({ productId: 'p', listPrice: 100, discountPct: 0, cost: cost(120), minMarginPct: 25 });
      expect(loss).toMatchObject({ verdict: 'BLOCK', marginPct: -20, maxDiscountPct: 0 });
    });

    it('computes a maxDiscountPct that itself always passes', () => {
      const r = sg.evaluateMargin({ productId: 'p', listPrice: 1299.99, discountPct: 0, cost: cost(611.37), minMarginPct: 25 });
      const check = sg.evaluateMargin({
        productId: 'p',
        listPrice: 1299.99,
        discountPct: r.maxDiscountPct!,
        cost: cost(611.37),
        minMarginPct: 25,
      });
      expect(check.verdict).toBe('PASS');
    });

    it('warns (not blocks) when relying on manual cost', () => {
      const r = sg.evaluateMargin({ productId: 'p', listPrice: 100, discountPct: 10, cost: cost(50, 'standard_cost'), minMarginPct: 25 });
      expect(r.verdict).toBe('WARN');
      expect(r.issues.map((i) => i.code)).toEqual(['COST_FROM_STANDARD_COST']);
    });

    it('blocks unknown cost, zero price, and out-of-range discounts', () => {
      const unknown = sg.evaluateMargin({ productId: 'p', listPrice: 100, discountPct: 10, cost: cost(null, 'unknown'), minMarginPct: 25 });
      expect(unknown.issues.map((i) => i.code)).toEqual(['COST_UNKNOWN']);
      expect(unknown.marginPct).toBeNull();

      expect(sg.evaluateMargin({ productId: 'p', listPrice: 0, discountPct: 10, cost: cost(5), minMarginPct: 25 }).issues[0].code).toBe(
        'INVALID_PRICE'
      );
      for (const d of [-1, 100, 150, Number.NaN]) {
        expect(sg.evaluateMargin({ productId: 'p', listPrice: 100, discountPct: d, cost: cost(5), minMarginPct: 25 }).verdict).toBe('BLOCK');
      }
    });
  });

  // ---------------------------------------------------------------------------
  describe('checkMarginViability (DB-backed cost resolution)', () => {
    it('uses purchase-history weighted average cost over the manual cost', async () => {
      const { product } = await makeProduct({ price: 200, cost: 10 });
      await receive(product.id, [
        { qty: 1, unitCost: 100 },
        { qty: 3, unitCost: 120 },
      ]); // weighted avg = (100 + 360) / 4 = 115
      const r = await sg.checkMarginViability(product.id, 10); // promo 180 → (180-115)/180 = 36.11%
      expect(r).toMatchObject({ costSource: 'purchase_history', unitCost: 115, promoPrice: 180, marginPct: 36.11, verdict: 'PASS' });

      const tooDeep = await sg.checkMarginViability(product.id, 30); // promo 140 → 17.86%
      expect(tooDeep.verdict).toBe('BLOCK');
    });

    it('falls back to manual cost with a warning', async () => {
      const { product } = await makeProduct({ price: 100, cost: 50 });
      const r = await sg.checkMarginViability(product.id, 10);
      expect(r).toMatchObject({ costSource: 'standard_cost', verdict: 'WARN', marginPct: 44.44 });
    });

    it('blocks when no cost exists anywhere (cost 0 is never treated as real)', async () => {
      const { product } = await makeProduct({ price: 100, cost: 0 });
      expect(await sg.checkMarginViability(product.id, 5)).toMatchObject({ verdict: 'BLOCK', costSource: 'unknown' });
    });

    it('blocks a missing product', async () => {
      expect((await sg.checkMarginViability('nope', 5)).issues[0].code).toBe('PRODUCT_NOT_FOUND');
    });
  });

  // ---------------------------------------------------------------------------
  describe('getTopPerformingProducts', () => {
    const now = new Date('2021-06-30T00:00:00Z');
    const inWindow = new Date('2021-06-15T00:00:00Z');
    const outOfWindow = new Date('2020-01-01T00:00:00Z');
    // Orders created by earlier tests in this file are dated "today" (after
    // `now`), so the window's upper bound is what isolates this test.
    const afterNow = new Date('2021-07-15T00:00:00Z');

    it('ranks by units sold on realised orders within the window only', async () => {
      const a = await makeProduct({ price: 100, cost: 40, stock: [10] });
      const b = await makeProduct({ price: 100, cost: 40, stock: [1] });
      const c = await makeProduct({ price: 100, cost: 40, stock: [10] });
      const inactive = await makeProduct({ stock: [10], active: false });

      await makeOrder(a.product.id, 5, 'DELIVERED', { createdAt: inWindow });
      await makeOrder(a.product.id, 1, 'CONFIRMED', { createdAt: inWindow });
      await makeOrder(b.product.id, 9, 'SHIPPED', { createdAt: inWindow });
      // Excluded: drafts, cancelled, refunded, out-of-window, inactive product.
      await makeOrder(c.product.id, 50, 'DRAFT', { createdAt: inWindow });
      await makeOrder(c.product.id, 50, 'CANCELLED', { createdAt: inWindow });
      await makeOrder(c.product.id, 50, 'REFUNDED', { createdAt: inWindow });
      await makeOrder(c.product.id, 50, 'DELIVERED', { createdAt: outOfWindow });
      await makeOrder(c.product.id, 50, 'DELIVERED', { createdAt: afterNow });
      await makeOrder(inactive.product.id, 99, 'DELIVERED', { createdAt: inWindow });

      const top = await sg.getTopPerformingProducts(10, { lookbackDays: 30, now });
      expect(top.map((t) => t.productId)).toEqual([b.product.id, a.product.id]);
      expect(top[0]).toMatchObject({ unitsSold: 9, orderCount: 1, velocityPerDay: 0.3, currentMarginPct: 60, costSource: 'standard_cost' });
      expect(top[1]).toMatchObject({ unitsSold: 6, orderCount: 2, revenue: 600 });
      // b has 1 unit on hand → its inventory safeguard blocks promotion.
      expect(top[0].inventory.verdict).toBe('BLOCK');
      expect(top[1].inventory.verdict).toBe('PASS');
    });

    it('respects the limit', async () => {
      const top = await sg.getTopPerformingProducts(1, { lookbackDays: 30, now });
      expect(top).toHaveLength(1);
    });
  });

  // ---------------------------------------------------------------------------
  describe('read-only guarantee', () => {
    it('no call changes any core row count', async () => {
      const { product } = await makeProduct({ price: 100, cost: 50, stock: [5] });
      const tables = [
        'product',
        'productVariant',
        'stockLevel',
        'stockMovement',
        'warehouse',
        'salesOrder',
        'salesOrderItem',
        'purchaseOrder',
        'goodsReceipt',
        'auditLog',
        'task',
        'automationLog',
      ] as const;
      const count = async () =>
        Promise.all(tables.map((t) => (db.prisma[t] as unknown as { count: () => Promise<number> }).count()));
      const before = await count();
      const updatedBefore = await db.prisma.product.findUniqueOrThrow({ where: { id: product.id } });

      await sg.checkInventoryStatus(product.id);
      await sg.checkMarginViability(product.id, 15);
      await sg.getTopPerformingProducts(5);

      expect(await count()).toEqual(before);
      const updatedAfter = await db.prisma.product.findUniqueOrThrow({ where: { id: product.id } });
      expect(updatedAfter.updatedAt).toEqual(updatedBefore.updatedAt);
    });

    it('safeguards.ts contains no write calls', () => {
      const src = fs.readFileSync(path.resolve(__dirname, '../src/marketing/ai/safeguards.ts'), 'utf8');
      expect(src).not.toMatch(/\.(create|createMany|update|updateMany|upsert|delete|deleteMany)\(/);
      expect(src).not.toMatch(/\$executeRaw|\$queryRaw|\$transaction/);
    });
  });
});
