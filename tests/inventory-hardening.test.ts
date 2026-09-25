import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { TestDb } from './test-db';
import { startTestDb } from './test-db';

/**
 * Phase 1 inventory hardening (SYSTEM_AUDIT.md D2, D3, and the I-section
 * negative-StockLevel gap). Covers what tests/sales-order-inventory-
 * lifecycle.test.ts does not: editing a sales order that already affects
 * inventory (D2), goods-receipt over-receiving and its transactionality
 * (D3), manual adjustments, and concurrency at the StockLevel-update layer
 * shared by all three. See docs/INVENTORY_RULES.md.
 */
describe('Inventory hardening (Phase 1)', () => {
  let db: TestDb;
  let updateSalesOrderWithInventoryReconciliation: typeof import('../src/lib/sales-orders')['updateSalesOrderWithInventoryReconciliation'];
  let createSalesOrderWithInventoryEffect: typeof import('../src/lib/sales-orders')['createSalesOrderWithInventoryEffect'];
  let receiveGoodsForPurchaseOrder: typeof import('../src/lib/purchase-orders')['receiveGoodsForPurchaseOrder'];
  let OverReceiptError: typeof import('../src/lib/purchase-orders')['OverReceiptError'];
  let InvalidPurchaseOrderTransitionError: typeof import('../src/lib/purchase-orders')['InvalidPurchaseOrderTransitionError'];
  let recordStockMovement: typeof import('../src/lib/automations/stock')['recordStockMovement'];

  beforeAll(async () => {
    db = await startTestDb();
    process.env.DATABASE_URL = db.url;
    const salesOrders = await import('../src/lib/sales-orders');
    updateSalesOrderWithInventoryReconciliation = salesOrders.updateSalesOrderWithInventoryReconciliation;
    createSalesOrderWithInventoryEffect = salesOrders.createSalesOrderWithInventoryEffect;
    const purchaseOrders = await import('../src/lib/purchase-orders');
    receiveGoodsForPurchaseOrder = purchaseOrders.receiveGoodsForPurchaseOrder;
    OverReceiptError = purchaseOrders.OverReceiptError;
    InvalidPurchaseOrderTransitionError = purchaseOrders.InvalidPurchaseOrderTransitionError;
    const stock = await import('../src/lib/automations/stock');
    recordStockMovement = stock.recordStockMovement;
  }, 60000);

  afterAll(async () => {
    await db.stop();
  });

  let warehouseId: string;

  beforeEach(async () => {
    // Only one warehouse may be `isDefault: true` at a time — see the note
    // in sales-order-status-transition.test.ts for why this matters.
    await db.prisma.warehouse.updateMany({ where: { isDefault: true }, data: { isDefault: false } });
    const wh = await db.prisma.warehouse.create({ data: { name: `WH-${Math.random()}`, isDefault: true } });
    warehouseId = wh.id;
  });

  async function makeVariant(trackInventory = true) {
    const product = await db.prisma.product.create({
      data: { sku: `SKU-${Math.random().toString(36).slice(2)}`, name: 'Test brick', trackInventory },
    });
    return db.prisma.productVariant.create({
      data: { productId: product.id, sku: `${product.sku}-v`, name: 'Default' },
    });
  }

  async function level(variantId: string) {
    const l = await db.prisma.stockLevel.findUnique({
      where: { productVariantId_warehouseId: { productVariantId: variantId, warehouseId } },
    });
    return l?.quantity ?? null;
  }

  async function movements(referenceType: string, referenceId: string) {
    return db.prisma.stockMovement.findMany({
      where: { referenceType, referenceId },
      orderBy: { createdAt: 'asc' },
    });
  }

  describe('Sales order edit reconciliation (D2)', () => {
    async function seedConfirmedOrder(quantity: number, startingStock = 20) {
      const variant = await makeVariant();
      await db.prisma.stockLevel.create({ data: { productVariantId: variant.id, warehouseId, quantity: startingStock } });
      const order = await db.prisma.salesOrder.create({
        data: {
          number: `SO-EDIT-${Math.random().toString(36).slice(2)}`,
          status: 'DRAFT',
          total: 100,
          items: {
            create: [{ productVariantId: variant.id, description: 'Test brick', quantity, unitPrice: 20 }],
          },
        },
        include: { items: true },
      });
      const { transitionSalesOrderStatus } = await import('../src/lib/sales-orders');
      await transitionSalesOrderStatus(order.id, 'CONFIRMED');
      return { order, variant, startingStock };
    }

    function toItemInput(item: { productId: string | null; productVariantId: string | null; description: string; quantity: unknown; unitPrice: unknown; taxRate: unknown; discount: unknown }) {
      return {
        productId: item.productId,
        productVariantId: item.productVariantId,
        description: item.description,
        quantity: Number(item.quantity),
        unitPrice: Number(item.unitPrice),
        taxRate: Number(item.taxRate),
        discount: Number(item.discount),
      };
    }

    it('editing a DRAFT order (never deducted) creates no stock movement', async () => {
      const variant = await makeVariant();
      await db.prisma.stockLevel.create({ data: { productVariantId: variant.id, warehouseId, quantity: 20 } });
      const order = await db.prisma.salesOrder.create({
        data: {
          number: `SO-EDIT-${Math.random().toString(36).slice(2)}`,
          status: 'DRAFT',
          total: 100,
          items: { create: [{ productVariantId: variant.id, description: 'Test brick', quantity: 5, unitPrice: 20 }] },
        },
        include: { items: true },
      });

      await updateSalesOrderWithInventoryReconciliation(
        order.id,
        { status: 'DRAFT', items: [{ ...toItemInput(order.items[0]), quantity: 8 }] },
        { subtotal: 160, taxTotal: 0, discountTotal: 0, total: 160 }
      );

      expect(await movements('SALES_ORDER', order.id)).toHaveLength(0);
      expect(await level(variant.id)).toBe(20);
    });

    it('increasing quantity on a CONFIRMED order reverses the old amount and deducts the new amount', async () => {
      const { order, variant, startingStock } = await seedConfirmedOrder(10);

      await updateSalesOrderWithInventoryReconciliation(
        order.id,
        { status: 'CONFIRMED', items: [{ ...toItemInput(order.items[0]), quantity: 15 }] },
        { subtotal: 300, taxTotal: 0, discountTotal: 0, total: 300 }
      );

      const mv = await movements('SALES_ORDER', order.id);
      expect(mv).toHaveLength(3); // original OUT 10, reversal IN 10, reapply OUT 15
      expect(mv.map((m) => [m.type, m.quantity])).toEqual([
        ['OUT', 10],
        ['IN', 10],
        ['OUT', 15],
      ]);
      expect(await level(variant.id)).toBe(startingStock - 15);
    });

    it('decreasing quantity on a CONFIRMED order returns the difference', async () => {
      const { order, variant, startingStock } = await seedConfirmedOrder(10);

      await updateSalesOrderWithInventoryReconciliation(
        order.id,
        { status: 'CONFIRMED', items: [{ ...toItemInput(order.items[0]), quantity: 4 }] },
        { subtotal: 80, taxTotal: 0, discountTotal: 0, total: 80 }
      );

      expect(await level(variant.id)).toBe(startingStock - 4);
      const mv = await movements('SALES_ORDER', order.id);
      expect(mv.map((m) => m.type)).toEqual(['OUT', 'IN', 'OUT']);
    });

    it('resubmitting an identical edit (no real change) creates no additional movement', async () => {
      const { order, variant, startingStock } = await seedConfirmedOrder(10);
      const current = await db.prisma.salesOrder.findUniqueOrThrow({ where: { id: order.id }, include: { items: true } });

      const input = { status: 'CONFIRMED' as const, items: current.items.map(toItemInput) };
      const totals = { subtotal: 200, taxTotal: 0, discountTotal: 0, total: 200 };
      await updateSalesOrderWithInventoryReconciliation(order.id, input, totals);
      await updateSalesOrderWithInventoryReconciliation(order.id, input, totals);

      expect(await movements('SALES_ORDER', order.id)).toHaveLength(1); // just the original CONFIRM
      expect(await level(variant.id)).toBe(startingStock - 10);
    });

    it('editing quantity AND cancelling in the same request restores exactly what was actually deducted, not the edited amount', async () => {
      // This is the exact scenario SYSTEM_AUDIT.md D2 described: qty 10 ->
      // CONFIRMED (OUT 10) -> edited to 15 -> cancelled. It must restore 10
      // (what actually left the warehouse), not 15.
      const { order, variant, startingStock } = await seedConfirmedOrder(10);

      await updateSalesOrderWithInventoryReconciliation(
        order.id,
        { status: 'CANCELLED', items: [{ ...toItemInput(order.items[0]), quantity: 15 }] },
        { subtotal: 300, taxTotal: 0, discountTotal: 0, total: 300 }
      );

      expect(await level(variant.id)).toBe(startingStock); // fully back to starting stock, not over/under
      const mv = await movements('SALES_ORDER', order.id);
      expect(mv.map((m) => [m.type, m.quantity])).toEqual([
        ['OUT', 10],
        ['IN', 10],
      ]);
    });

    it('changing status to CONFIRMED via the edit route (not the dedicated status endpoint) still deducts stock', async () => {
      const variant = await makeVariant();
      await db.prisma.stockLevel.create({ data: { productVariantId: variant.id, warehouseId, quantity: 20 } });
      const order = await db.prisma.salesOrder.create({
        data: {
          number: `SO-EDIT-${Math.random().toString(36).slice(2)}`,
          status: 'DRAFT',
          total: 100,
          items: { create: [{ productVariantId: variant.id, description: 'Test brick', quantity: 6, unitPrice: 20 }] },
        },
        include: { items: true },
      });

      await updateSalesOrderWithInventoryReconciliation(
        order.id,
        { status: 'CONFIRMED', items: order.items.map(toItemInput) },
        { subtotal: 120, taxTotal: 0, discountTotal: 0, total: 120 }
      );

      expect(await level(variant.id)).toBe(14);
      const mv = await movements('SALES_ORDER', order.id);
      expect(mv).toHaveLength(1);
      expect(mv[0].type).toBe('OUT');
    });

    it('creating an order directly with status CONFIRMED deducts stock immediately', async () => {
      const variant = await makeVariant();
      await db.prisma.stockLevel.create({ data: { productVariantId: variant.id, warehouseId, quantity: 20 } });

      const order = await createSalesOrderWithInventoryEffect(
        {
          status: 'CONFIRMED',
          items: [{ productVariantId: variant.id, description: 'Test brick', quantity: 7, unitPrice: 20, taxRate: 0, discount: 0 }],
        },
        { subtotal: 140, taxTotal: 0, discountTotal: 0, total: 140 }
      );

      expect(await level(variant.id)).toBe(13);
      const mv = await movements('SALES_ORDER', order.id);
      expect(mv).toHaveLength(1);
      expect(mv[0].type).toBe('OUT');
    });

    it('concurrent edits to the same order do not lose or duplicate the reconciliation', async () => {
      const { order, variant, startingStock } = await seedConfirmedOrder(10);
      const current = await db.prisma.salesOrder.findUniqueOrThrow({ where: { id: order.id }, include: { items: true } });

      const results = await Promise.allSettled([
        updateSalesOrderWithInventoryReconciliation(
          order.id,
          { status: 'CONFIRMED', items: [{ ...toItemInput(current.items[0]), quantity: 12 }] },
          { subtotal: 240, taxTotal: 0, discountTotal: 0, total: 240 }
        ),
        updateSalesOrderWithInventoryReconciliation(
          order.id,
          { status: 'CONFIRMED', items: [{ ...toItemInput(current.items[0]), quantity: 16 }] },
          { subtotal: 320, taxTotal: 0, discountTotal: 0, total: 320 }
        ),
      ]);

      expect(results.every((r) => r.status === 'fulfilled')).toBe(true);

      // The advisory lock serializes the two edits, so whichever ran last
      // determines the final quantity — but the ledger must reflect exactly
      // one reversal+reapply pair per edit, with no lost or duplicated
      // movements, and StockLevel must match whatever the final order says.
      const finalOrder = await db.prisma.salesOrder.findUniqueOrThrow({ where: { id: order.id }, include: { items: true } });
      const finalQty = Number(finalOrder.items[0].quantity);
      expect([12, 16]).toContain(finalQty);
      expect(await level(variant.id)).toBe(startingStock - finalQty);

      const mv = await movements('SALES_ORDER', order.id);
      // original CONFIRM (OUT 10) + two edits, each a reverse+reapply pair.
      expect(mv).toHaveLength(5);
      const outSum = mv.filter((m) => m.type === 'OUT').reduce((s, m) => s + m.quantity, 0);
      const inSum = mv.filter((m) => m.type === 'IN').reduce((s, m) => s + m.quantity, 0);
      expect(outSum - inSum).toBe(finalQty);
    });
  });

  describe('Goods receipt (D3: over-receiving guard)', () => {
    async function seedPurchaseOrder(orderedQty: number) {
      const variant = await makeVariant();
      const po = await db.prisma.purchaseOrder.create({
        data: {
          number: `PO-${Math.random().toString(36).slice(2)}`,
          status: 'SENT',
          total: 100,
          items: {
            create: [{ productVariantId: variant.id, description: 'Test brick', quantity: orderedQty, unitCost: 10 }],
          },
        },
        include: { items: true },
      });
      return { po, variant, poItemId: po.items[0].id };
    }

    it('receiving within the ordered quantity creates one IN movement and updates quantityReceived', async () => {
      const { po, variant, poItemId } = await seedPurchaseOrder(20);

      const result = await receiveGoodsForPurchaseOrder(po.id, warehouseId, [
        { purchaseOrderItemId: poItemId, productVariantId: variant.id, quantity: 12 },
      ]);

      expect(result.status).toBe('PARTIALLY_RECEIVED');
      expect(await level(variant.id)).toBe(12);
      const mv = await movements('GOODS_RECEIPT', result.receipt.id);
      expect(mv).toHaveLength(1);
      expect(mv[0].type).toBe('IN');

      const poItem = await db.prisma.purchaseOrderItem.findUniqueOrThrow({ where: { id: poItemId } });
      expect(Number(poItem.quantityReceived)).toBe(12);
    });

    it('a second, legitimate partial receipt within the remaining budget succeeds and completes the PO', async () => {
      const { po, variant, poItemId } = await seedPurchaseOrder(20);
      await receiveGoodsForPurchaseOrder(po.id, warehouseId, [
        { purchaseOrderItemId: poItemId, productVariantId: variant.id, quantity: 12 },
      ]);
      const second = await receiveGoodsForPurchaseOrder(po.id, warehouseId, [
        { purchaseOrderItemId: poItemId, productVariantId: variant.id, quantity: 8 },
      ]);

      expect(second.status).toBe('RECEIVED');
      expect(await level(variant.id)).toBe(20);
      const poItem = await db.prisma.purchaseOrderItem.findUniqueOrThrow({ where: { id: poItemId } });
      expect(Number(poItem.quantityReceived)).toBe(20);
    });

    it('repeated/duplicate receiving after the PO is already fully RECEIVED is rejected by the lifecycle guard, with nothing written', async () => {
      const { po, variant, poItemId } = await seedPurchaseOrder(10);
      await receiveGoodsForPurchaseOrder(po.id, warehouseId, [
        { purchaseOrderItemId: poItemId, productVariantId: variant.id, quantity: 10 },
      ]);

      // Same request, resubmitted (double-click / retry) — the PO is now
      // RECEIVED, so this is rejected by the lifecycle guard (Phase 7)
      // before the over-receipt math even runs; see the next test for the
      // over-receipt guard's own error when the PO is still receivable.
      await expect(
        receiveGoodsForPurchaseOrder(po.id, warehouseId, [
          { purchaseOrderItemId: poItemId, productVariantId: variant.id, quantity: 10 },
        ])
      ).rejects.toBeInstanceOf(InvalidPurchaseOrderTransitionError);

      expect(await level(variant.id)).toBe(10); // unchanged by the rejected attempt
      const poItem = await db.prisma.purchaseOrderItem.findUniqueOrThrow({ where: { id: poItemId } });
      expect(Number(poItem.quantityReceived)).toBe(10); // unchanged
      const allReceipts = await db.prisma.goodsReceipt.findMany({ where: { purchaseOrderId: po.id } });
      expect(allReceipts).toHaveLength(1); // the rejected attempt created no second receipt
    });

    it('a resubmission that would over-receive while the PO is still PARTIALLY_RECEIVED (not yet complete) is rejected by the over-receipt guard specifically', async () => {
      const { po, variant, poItemId } = await seedPurchaseOrder(10);
      await receiveGoodsForPurchaseOrder(po.id, warehouseId, [
        { purchaseOrderItemId: poItemId, productVariantId: variant.id, quantity: 6 },
      ]);

      // PO is PARTIALLY_RECEIVED (still a receivable status) — a second
      // request for 6 more would total 12 against an order for only 10.
      await expect(
        receiveGoodsForPurchaseOrder(po.id, warehouseId, [
          { purchaseOrderItemId: poItemId, productVariantId: variant.id, quantity: 6 },
        ])
      ).rejects.toBeInstanceOf(OverReceiptError);

      expect(await level(variant.id)).toBe(6); // unchanged by the rejected attempt
      const poItem = await db.prisma.purchaseOrderItem.findUniqueOrThrow({ where: { id: poItemId } });
      expect(Number(poItem.quantityReceived)).toBe(6);
    });

    it('concurrent receiving requests racing near the remaining-quantity boundary: at most the ordered amount is ever received', async () => {
      const { po, variant, poItemId } = await seedPurchaseOrder(10);

      // Two concurrent requests each ask for 8 against a PO for only 10 —
      // together they'd over-receive by 6. The advisory lock serializes
      // them, so the first to commit succeeds and the second sees the
      // now-true remaining quantity (2) and is rejected.
      const results = await Promise.allSettled([
        receiveGoodsForPurchaseOrder(po.id, warehouseId, [
          { purchaseOrderItemId: poItemId, productVariantId: variant.id, quantity: 8 },
        ]),
        receiveGoodsForPurchaseOrder(po.id, warehouseId, [
          { purchaseOrderItemId: poItemId, productVariantId: variant.id, quantity: 8 },
        ]),
      ]);

      const fulfilled = results.filter((r) => r.status === 'fulfilled');
      const rejected = results.filter((r) => r.status === 'rejected');
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(OverReceiptError);

      const poItem = await db.prisma.purchaseOrderItem.findUniqueOrThrow({ where: { id: poItemId } });
      expect(Number(poItem.quantityReceived)).toBe(8); // only the winning request's amount
      expect(await level(variant.id)).toBe(8);
    });
  });

  describe('Manual adjustment', () => {
    it('a manual IN adjustment records a movement and raises StockLevel', async () => {
      const variant = await makeVariant();
      await db.prisma.stockLevel.create({ data: { productVariantId: variant.id, warehouseId, quantity: 5 } });

      await recordStockMovement({
        productVariantId: variant.id,
        warehouseId,
        type: 'IN',
        quantity: 3,
        referenceType: 'MANUAL_ADJUSTMENT',
        reason: 'Manual in by test',
      });

      expect(await level(variant.id)).toBe(8);
      const mv = await db.prisma.stockMovement.findMany({ where: { productVariantId: variant.id, referenceType: 'MANUAL_ADJUSTMENT' } });
      expect(mv).toHaveLength(1);
      expect(mv[0].type).toBe('IN');
    });

    it('an OUT adjustment larger than what is on hand is recorded but never drives StockLevel negative', async () => {
      const variant = await makeVariant();
      await db.prisma.stockLevel.create({ data: { productVariantId: variant.id, warehouseId, quantity: 5 } });

      await recordStockMovement({
        productVariantId: variant.id,
        warehouseId,
        type: 'OUT',
        quantity: 9,
        referenceType: 'MANUAL_ADJUSTMENT',
        reason: 'Manual out by test (over-correction)',
      });

      // The movement itself preserves the real requested amount (audit
      // trail is not lied to)...
      const mv = await db.prisma.stockMovement.findMany({ where: { productVariantId: variant.id, referenceType: 'MANUAL_ADJUSTMENT' } });
      expect(mv).toHaveLength(1);
      expect(mv[0].quantity).toBe(9);
      // ...but the resulting level is floored at zero, not negative.
      expect(await level(variant.id)).toBe(0);
    });

    it('concurrent manual adjustments on the same variant/warehouse are both applied (no lost update)', async () => {
      const variant = await makeVariant();
      await db.prisma.stockLevel.create({ data: { productVariantId: variant.id, warehouseId, quantity: 50 } });

      await Promise.all([
        recordStockMovement({ productVariantId: variant.id, warehouseId, type: 'OUT', quantity: 10, referenceType: 'MANUAL_ADJUSTMENT' }),
        recordStockMovement({ productVariantId: variant.id, warehouseId, type: 'OUT', quantity: 15, referenceType: 'MANUAL_ADJUSTMENT' }),
        recordStockMovement({ productVariantId: variant.id, warehouseId, type: 'IN', quantity: 5, referenceType: 'MANUAL_ADJUSTMENT' }),
      ]);

      // 50 - 10 - 15 + 5 = 30, regardless of the order the three concurrent
      // writes actually committed in.
      expect(await level(variant.id)).toBe(30);
      const mv = await db.prisma.stockMovement.findMany({ where: { productVariantId: variant.id, referenceType: 'MANUAL_ADJUSTMENT' } });
      expect(mv).toHaveLength(3);
    });

    it('concurrent adjustments that would collectively go negative still floor at zero without losing either movement record', async () => {
      const variant = await makeVariant();
      await db.prisma.stockLevel.create({ data: { productVariantId: variant.id, warehouseId, quantity: 10 } });

      await Promise.all([
        recordStockMovement({ productVariantId: variant.id, warehouseId, type: 'OUT', quantity: 8, referenceType: 'MANUAL_ADJUSTMENT' }),
        recordStockMovement({ productVariantId: variant.id, warehouseId, type: 'OUT', quantity: 8, referenceType: 'MANUAL_ADJUSTMENT' }),
      ]);

      expect(await level(variant.id)).toBe(0);
      const mv = await db.prisma.stockMovement.findMany({ where: { productVariantId: variant.id, referenceType: 'MANUAL_ADJUSTMENT' } });
      expect(mv).toHaveLength(2); // both OUT movements are on record even though the level floored
      expect(mv.reduce((s, m) => s + m.quantity, 0)).toBe(16);
    });
  });
});
