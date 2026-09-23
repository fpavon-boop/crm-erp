import { prisma } from '@/lib/prisma';
import { applyGoodsReceiptInventoryEffect } from '@/lib/automations/stock';
import type { GoodsReceipt, GoodsReceiptItem, PurchaseOrderStatus } from '@prisma/client';

export class PurchaseOrderNotFoundError extends Error {
  constructor(purchaseOrderId: string) {
    super(`Purchase order ${purchaseOrderId} not found`);
    this.name = 'PurchaseOrderNotFoundError';
  }
}

export interface OverReceiptViolation {
  purchaseOrderItemId: string;
  requested: number;
  remaining: number;
}

/** Thrown when a receive request would push one or more items'
 * quantityReceived past their ordered quantity (SYSTEM_AUDIT.md D3) — a
 * typo, or a duplicate submission of an already-processed receipt. Nothing
 * is written when this is thrown; the whole request is rejected up front. */
export class OverReceiptError extends Error {
  constructor(public readonly violations: OverReceiptViolation[]) {
    super('This would receive more than the ordered quantity for one or more items.');
    this.name = 'OverReceiptError';
  }
}

export interface ReceiveGoodsItemInput {
  purchaseOrderItemId: string;
  productId?: string | null;
  productVariantId?: string | null;
  quantity: number;
}

export interface ReceiveGoodsResult {
  receipt: GoodsReceipt & { items: GoodsReceiptItem[] };
  status: PurchaseOrderStatus;
}

/**
 * Records a goods receipt against a purchase order: creates the
 * GoodsReceipt (+ items), posts the matching IN stock movements, increments
 * each item's quantityReceived, and updates the PO's status — all in one
 * transaction, so a crash partway through never leaves a receipt recorded
 * without its stock effect (or vice versa).
 *
 * Guards against over-receiving (SYSTEM_AUDIT.md D3): if any item's
 * requested quantity would push its quantityReceived past its ordered
 * quantity, the whole request is rejected before anything is written — a
 * genuinely new partial shipment within the remaining quantity is still
 * allowed (receiving is normally split across multiple calls), but a typo
 * or an accidental duplicate submission that would over-receive is not.
 *
 * Concurrency: a Postgres advisory transaction lock keyed by the purchase
 * order id (the same pattern used for sales-order edits and invoice
 * creation) serializes concurrent receiving against the *same* PO, so two
 * simultaneous receive requests can't both read "remaining quantity" before
 * either has written — the second sees the first's committed increments and
 * is checked against the true remaining amount, so two requests racing to
 * receive the last of an item's remaining quantity can't both succeed.
 */
export async function receiveGoodsForPurchaseOrder(
  purchaseOrderId: string,
  warehouseId: string,
  items: ReceiveGoodsItemInput[]
): Promise<ReceiveGoodsResult> {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${purchaseOrderId}))`;

    const purchaseOrder = await tx.purchaseOrder.findUnique({
      where: { id: purchaseOrderId },
      include: { items: true },
    });
    if (!purchaseOrder) throw new PurchaseOrderNotFoundError(purchaseOrderId);

    const poItemsById = new Map(purchaseOrder.items.map((i) => [i.id, i]));
    const violations: OverReceiptViolation[] = [];
    for (const item of items) {
      const poItem = poItemsById.get(item.purchaseOrderItemId);
      if (!poItem) continue;
      const remaining = Number(poItem.quantity) - Number(poItem.quantityReceived);
      if (item.quantity > remaining + 1e-9) {
        violations.push({ purchaseOrderItemId: item.purchaseOrderItemId, requested: item.quantity, remaining });
      }
    }
    if (violations.length > 0) {
      throw new OverReceiptError(violations);
    }

    const receipt = await tx.goodsReceipt.create({
      data: { purchaseOrderId, warehouseId, items: { create: items } },
      include: { items: true },
    });

    await applyGoodsReceiptInventoryEffect(receipt.id, tx);

    const updatedItems = await tx.purchaseOrderItem.findMany({ where: { purchaseOrderId } });
    const fullyReceived = updatedItems.every((i) => Number(i.quantityReceived) >= Number(i.quantity));
    const anyReceived = updatedItems.some((i) => Number(i.quantityReceived) > 0);
    const status: PurchaseOrderStatus = fullyReceived
      ? 'RECEIVED'
      : anyReceived
        ? 'PARTIALLY_RECEIVED'
        : purchaseOrder.status;

    await tx.purchaseOrder.update({ where: { id: purchaseOrderId }, data: { status } });

    return { receipt, status };
  });
}
