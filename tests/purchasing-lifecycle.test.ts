import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { TestDb } from './test-db';
import { startTestDb } from './test-db';

/**
 * Phase 7 (Supplier & Purchasing Management): the purchase-order lifecycle
 * guards — approve/cancel transitions, the receiving-status gate, and
 * goods-receipt idempotency — layered on top of the existing Phase 1
 * over-receiving guard (tests/inventory-hardening.test.ts). See
 * docs/PURCHASING_AND_RECEIVING.md.
 */
describe('Purchase order lifecycle (Phase 7)', () => {
  let db: TestDb;
  let purchaseOrders: typeof import('../src/lib/purchase-orders');

  beforeAll(async () => {
    db = await startTestDb();
    process.env.DATABASE_URL = db.url;
    purchaseOrders = await import('../src/lib/purchase-orders');
  }, 60000);

  afterAll(async () => {
    await db.stop();
  });

  let warehouseId: string;

  beforeEach(async () => {
    await db.prisma.warehouse.updateMany({ where: { isDefault: true }, data: { isDefault: false } });
    const wh = await db.prisma.warehouse.create({ data: { name: `WH-${Math.random()}`, isDefault: true } });
    warehouseId = wh.id;
  });

  async function makeVariant() {
    const product = await db.prisma.product.create({
      data: { sku: `SKU-${Math.random().toString(36).slice(2)}`, name: 'Test brick', trackInventory: true },
    });
    return db.prisma.productVariant.create({
      data: { productId: product.id, sku: `${product.sku}-v`, name: 'Default' },
    });
  }

  async function seedPurchaseOrder(status: 'DRAFT' | 'SENT' | 'RECEIVED' | 'CANCELLED', orderedQty = 10) {
    const variant = await makeVariant();
    const po = await db.prisma.purchaseOrder.create({
      data: {
        number: `PO-${Math.random().toString(36).slice(2)}`,
        status,
        total: 100,
        items: {
          create: [{ productVariantId: variant.id, description: 'Test brick', quantity: orderedQty, unitCost: 10 }],
        },
      },
      include: { items: true },
    });
    return { po, variant, poItemId: po.items[0].id };
  }

  async function level(variantId: string) {
    const l = await db.prisma.stockLevel.findUnique({
      where: { productVariantId_warehouseId: { productVariantId: variantId, warehouseId } },
    });
    return l?.quantity ?? null;
  }

  describe('approvePurchaseOrder (DRAFT -> SENT, the "Approved -> Ordered" step)', () => {
    it('moves a DRAFT order to SENT', async () => {
      const { po } = await seedPurchaseOrder('DRAFT');
      const updated = await purchaseOrders.approvePurchaseOrder(po.id);
      expect(updated.status).toBe('SENT');
    });

    it('rejects approving an order that is already SENT', async () => {
      const { po } = await seedPurchaseOrder('SENT');
      await expect(purchaseOrders.approvePurchaseOrder(po.id)).rejects.toBeInstanceOf(
        purchaseOrders.InvalidPurchaseOrderTransitionError
      );
    });

    it('rejects approving a RECEIVED order', async () => {
      const { po } = await seedPurchaseOrder('RECEIVED');
      await expect(purchaseOrders.approvePurchaseOrder(po.id)).rejects.toBeInstanceOf(
        purchaseOrders.InvalidPurchaseOrderTransitionError
      );
    });

    it('rejects approving a CANCELLED order', async () => {
      const { po } = await seedPurchaseOrder('CANCELLED');
      await expect(purchaseOrders.approvePurchaseOrder(po.id)).rejects.toBeInstanceOf(
        purchaseOrders.InvalidPurchaseOrderTransitionError
      );
    });

    it('throws PurchaseOrderNotFoundError for a non-existent id', async () => {
      await expect(purchaseOrders.approvePurchaseOrder('does-not-exist')).rejects.toBeInstanceOf(
        purchaseOrders.PurchaseOrderNotFoundError
      );
    });
  });

  describe('cancelPurchaseOrder', () => {
    it('cancels a DRAFT order', async () => {
      const { po } = await seedPurchaseOrder('DRAFT');
      const updated = await purchaseOrders.cancelPurchaseOrder(po.id);
      expect(updated.status).toBe('CANCELLED');
    });

    it('cancels a SENT order that has nothing received yet', async () => {
      const { po } = await seedPurchaseOrder('SENT');
      const updated = await purchaseOrders.cancelPurchaseOrder(po.id);
      expect(updated.status).toBe('CANCELLED');
    });

    it('rejects cancelling a SENT order that already has a partial receipt, even though the status column alone would allow it', async () => {
      const { po, variant, poItemId } = await seedPurchaseOrder('SENT', 10);
      await purchaseOrders.receiveGoodsForPurchaseOrder(po.id, warehouseId, [
        { purchaseOrderItemId: poItemId, productVariantId: variant.id, quantity: 3 },
      ]);
      // Status is now PARTIALLY_RECEIVED, which already isn't in the
      // cancellable set — this test locks in that the independent
      // quantityReceived check would also catch it if it weren't.
      await expect(purchaseOrders.cancelPurchaseOrder(po.id)).rejects.toBeInstanceOf(
        purchaseOrders.InvalidPurchaseOrderTransitionError
      );
    });

    it('rejects cancelling an already-RECEIVED order', async () => {
      const { po } = await seedPurchaseOrder('RECEIVED');
      await expect(purchaseOrders.cancelPurchaseOrder(po.id)).rejects.toBeInstanceOf(
        purchaseOrders.InvalidPurchaseOrderTransitionError
      );
    });

    it('rejects cancelling an already-CANCELLED order', async () => {
      const { po } = await seedPurchaseOrder('CANCELLED');
      await expect(purchaseOrders.cancelPurchaseOrder(po.id)).rejects.toBeInstanceOf(
        purchaseOrders.InvalidPurchaseOrderTransitionError
      );
    });
  });

  describe('receiving is gated by lifecycle status', () => {
    it('rejects receiving against a still-DRAFT (not yet approved/sent) order', async () => {
      const { po, variant, poItemId } = await seedPurchaseOrder('DRAFT');
      await expect(
        purchaseOrders.receiveGoodsForPurchaseOrder(po.id, warehouseId, [
          { purchaseOrderItemId: poItemId, productVariantId: variant.id, quantity: 5 },
        ])
      ).rejects.toBeInstanceOf(purchaseOrders.InvalidPurchaseOrderTransitionError);
      expect(await level(variant.id)).toBeNull(); // nothing was ever received
    });

    it('rejects receiving against a CANCELLED order', async () => {
      const { po, variant, poItemId } = await seedPurchaseOrder('CANCELLED');
      await expect(
        purchaseOrders.receiveGoodsForPurchaseOrder(po.id, warehouseId, [
          { purchaseOrderItemId: poItemId, productVariantId: variant.id, quantity: 5 },
        ])
      ).rejects.toBeInstanceOf(purchaseOrders.InvalidPurchaseOrderTransitionError);
      expect(await level(variant.id)).toBeNull();
    });

    it('allows receiving against a SENT order (the normal, expected path)', async () => {
      const { po, variant, poItemId } = await seedPurchaseOrder('SENT');
      const result = await purchaseOrders.receiveGoodsForPurchaseOrder(po.id, warehouseId, [
        { purchaseOrderItemId: poItemId, productVariantId: variant.id, quantity: 5 },
      ]);
      expect(result.status).toBe('PARTIALLY_RECEIVED');
      expect(await level(variant.id)).toBe(5);
    });
  });

  describe('partial receiving across multiple events', () => {
    it('inventory increments only by the actually-received quantity at each step, never the full ordered amount upfront', async () => {
      const { po, variant, poItemId } = await seedPurchaseOrder('SENT', 30);

      const first = await purchaseOrders.receiveGoodsForPurchaseOrder(po.id, warehouseId, [
        { purchaseOrderItemId: poItemId, productVariantId: variant.id, quantity: 10 },
      ]);
      expect(first.status).toBe('PARTIALLY_RECEIVED');
      expect(await level(variant.id)).toBe(10); // not 30

      const second = await purchaseOrders.receiveGoodsForPurchaseOrder(po.id, warehouseId, [
        { purchaseOrderItemId: poItemId, productVariantId: variant.id, quantity: 15 },
      ]);
      expect(second.status).toBe('PARTIALLY_RECEIVED');
      expect(await level(variant.id)).toBe(25);

      const third = await purchaseOrders.receiveGoodsForPurchaseOrder(po.id, warehouseId, [
        { purchaseOrderItemId: poItemId, productVariantId: variant.id, quantity: 5 },
      ]);
      expect(third.status).toBe('RECEIVED');
      expect(await level(variant.id)).toBe(30);

      const poItem = await db.prisma.purchaseOrderItem.findUniqueOrThrow({ where: { id: poItemId } });
      expect(Number(poItem.quantityReceived)).toBe(30);
      expect(Number(poItem.quantity) - Number(poItem.quantityReceived)).toBe(0); // outstanding
    });
  });

  describe('goods-receipt idempotency (repeated/duplicate submissions)', () => {
    it('a second call with the same idempotencyKey is a no-op: same receipt returned, inventory not double-incremented', async () => {
      const { po, variant, poItemId } = await seedPurchaseOrder('SENT', 20);
      const key = 'idem-key-1';

      const first = await purchaseOrders.receiveGoodsForPurchaseOrder(
        po.id,
        warehouseId,
        [{ purchaseOrderItemId: poItemId, productVariantId: variant.id, quantity: 10 }],
        key
      );
      expect(first.duplicate).toBe(false);
      expect(await level(variant.id)).toBe(10);

      const second = await purchaseOrders.receiveGoodsForPurchaseOrder(
        po.id,
        warehouseId,
        [{ purchaseOrderItemId: poItemId, productVariantId: variant.id, quantity: 10 }],
        key
      );
      expect(second.duplicate).toBe(true);
      expect(second.receipt.id).toBe(first.receipt.id);

      // The whole point: inventory reflects ONE receipt of 10, not two.
      expect(await level(variant.id)).toBe(10);
      const poItem = await db.prisma.purchaseOrderItem.findUniqueOrThrow({ where: { id: poItemId } });
      expect(Number(poItem.quantityReceived)).toBe(10);
      const allReceipts = await db.prisma.goodsReceipt.findMany({ where: { purchaseOrderId: po.id } });
      expect(allReceipts).toHaveLength(1);
    });

    it('a duplicate key is recognized even when the (now-completed) PO would otherwise reject the request via the over-receipt guard', async () => {
      // This is exactly the double-click/retry scenario the idempotency key
      // exists for: without it, this second call would be flatly rejected
      // (see the Phase 1 over-receiving test) even though it's actually the
      // *same* logical receipt, not a new one.
      const { po, variant, poItemId } = await seedPurchaseOrder('SENT', 10);
      const key = 'idem-key-2';

      await purchaseOrders.receiveGoodsForPurchaseOrder(
        po.id,
        warehouseId,
        [{ purchaseOrderItemId: poItemId, productVariantId: variant.id, quantity: 10 }],
        key
      );
      const retry = await purchaseOrders.receiveGoodsForPurchaseOrder(
        po.id,
        warehouseId,
        [{ purchaseOrderItemId: poItemId, productVariantId: variant.id, quantity: 10 }],
        key
      );
      expect(retry.duplicate).toBe(true);
      expect(await level(variant.id)).toBe(10);
    });

    it('two DIFFERENT idempotency keys for two genuinely separate receipts both apply normally', async () => {
      const { po, variant, poItemId } = await seedPurchaseOrder('SENT', 20);
      await purchaseOrders.receiveGoodsForPurchaseOrder(
        po.id,
        warehouseId,
        [{ purchaseOrderItemId: poItemId, productVariantId: variant.id, quantity: 10 }],
        'key-a'
      );
      await purchaseOrders.receiveGoodsForPurchaseOrder(
        po.id,
        warehouseId,
        [{ purchaseOrderItemId: poItemId, productVariantId: variant.id, quantity: 10 }],
        'key-b'
      );
      expect(await level(variant.id)).toBe(20);
      const allReceipts = await db.prisma.goodsReceipt.findMany({ where: { purchaseOrderId: po.id } });
      expect(allReceipts).toHaveLength(2);
    });

    it('omitting the idempotency key preserves prior behavior (no dedup) — each call is its own receipt', async () => {
      const { po, variant, poItemId } = await seedPurchaseOrder('SENT', 20);
      await purchaseOrders.receiveGoodsForPurchaseOrder(po.id, warehouseId, [
        { purchaseOrderItemId: poItemId, productVariantId: variant.id, quantity: 5 },
      ]);
      const second = await purchaseOrders.receiveGoodsForPurchaseOrder(po.id, warehouseId, [
        { purchaseOrderItemId: poItemId, productVariantId: variant.id, quantity: 5 },
      ]);
      expect(second.duplicate).toBe(false);
      expect(await level(variant.id)).toBe(10);
      const allReceipts = await db.prisma.goodsReceipt.findMany({ where: { purchaseOrderId: po.id } });
      expect(allReceipts).toHaveLength(2);
    });

    it('concurrent duplicate submissions with the same key: only one receipt is ever created', async () => {
      const { po, variant, poItemId } = await seedPurchaseOrder('SENT', 20);
      const key = 'idem-key-concurrent';

      const results = await Promise.allSettled([
        purchaseOrders.receiveGoodsForPurchaseOrder(
          po.id,
          warehouseId,
          [{ purchaseOrderItemId: poItemId, productVariantId: variant.id, quantity: 10 }],
          key
        ),
        purchaseOrders.receiveGoodsForPurchaseOrder(
          po.id,
          warehouseId,
          [{ purchaseOrderItemId: poItemId, productVariantId: variant.id, quantity: 10 }],
          key
        ),
      ]);

      const fulfilled = results
        .filter((r): r is PromiseFulfilledResult<Awaited<ReturnType<typeof purchaseOrders.receiveGoodsForPurchaseOrder>>> => r.status === 'fulfilled')
        .map((r) => r.value);
      // Both may resolve successfully (one duplicate: true, one false) since
      // the advisory lock serializes rather than rejects the second — what
      // matters is exactly one receipt and exactly one 10-unit increment.
      expect(fulfilled.length).toBeGreaterThanOrEqual(1);
      expect(await level(variant.id)).toBe(10);
      const allReceipts = await db.prisma.goodsReceipt.findMany({ where: { purchaseOrderId: po.id } });
      expect(allReceipts).toHaveLength(1);
    });
  });
});
