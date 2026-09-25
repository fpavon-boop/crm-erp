import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { applyGoodsReceiptInventoryEffect } from '@/lib/automations/stock';
import type { GoodsReceipt, GoodsReceiptItem, PurchaseOrder, PurchaseOrderStatus } from '@prisma/client';

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

/** Thrown by approvePurchaseOrder / cancelPurchaseOrder / (as a defense in
 * depth) receiveGoodsForPurchaseOrder when the purchase order's current
 * status doesn't allow the requested transition — see
 * docs/PURCHASING_AND_RECEIVING.md "Lifecycle and enforced transitions" for
 * the full state diagram. */
export class InvalidPurchaseOrderTransitionError extends Error {
  constructor(
    public readonly from: PurchaseOrderStatus,
    public readonly attempted: string
  ) {
    super(`Cannot transition purchase order from ${from} to ${attempted}.`);
    this.name = 'InvalidPurchaseOrderTransitionError';
  }
}

/** Statuses a purchase order must be in for goods to be received against
 * it: it must have been approved/sent (SENT) or already have a prior
 * partial receipt (PARTIALLY_RECEIVED). A still-DRAFT order was never
 * approved or placed with the supplier; a RECEIVED order has nothing left
 * to receive (the over-receipt guard would catch that anyway, but this
 * gives a clearer error and also covers a zero-line-item edge case);
 * CANCELLED must never accept goods. */
const RECEIVABLE_STATUSES = new Set<PurchaseOrderStatus>(['SENT', 'PARTIALLY_RECEIVED']);

/** Statuses a purchase order may be cancelled from — before it has ever
 * been sent to the supplier (DRAFT), or after being sent but before
 * anything has actually arrived (SENT with zero received quantity). Once
 * any receiving has happened the order is no longer cancellable — see
 * cancelPurchaseOrder. */
const CANCELLABLE_STATUSES = new Set<PurchaseOrderStatus>(['DRAFT', 'SENT']);

async function lockPurchaseOrder(tx: Prisma.TransactionClient, purchaseOrderId: string) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${purchaseOrderId}))`;
}

/**
 * Approves and places a purchase order with its supplier: DRAFT -> SENT.
 * This is the "Approved -> Ordered" step of the requested lifecycle
 * (Purchase Order -> Approved -> Ordered -> Partially Received -> Received
 * -> Supplier Invoice -> Payment) — this schema has no separate internal
 * "approved but not yet sent" checkpoint, so both concepts collapse onto
 * the existing SENT status rather than inventing a new, overlapping one
 * (see docs/PURCHASING_AND_RECEIVING.md "Status mapping"). Only valid from
 * DRAFT; any other current status is rejected.
 */
export async function approvePurchaseOrder(purchaseOrderId: string): Promise<PurchaseOrder> {
  return prisma.$transaction(async (tx) => {
    await lockPurchaseOrder(tx, purchaseOrderId);
    const po = await tx.purchaseOrder.findUnique({ where: { id: purchaseOrderId } });
    if (!po) throw new PurchaseOrderNotFoundError(purchaseOrderId);
    if (po.status !== 'DRAFT') throw new InvalidPurchaseOrderTransitionError(po.status, 'SENT');
    return tx.purchaseOrder.update({ where: { id: purchaseOrderId }, data: { status: 'SENT' } });
  });
}

/**
 * Cancels a purchase order: DRAFT or SENT -> CANCELLED. Rejected once any
 * receiving has occurred (checked directly against each item's
 * quantityReceived, not just the order's status label, as a second,
 * independent guard against ever cancelling an order that's holding
 * received inventory against it) or if the order is already RECEIVED,
 * PARTIALLY_RECEIVED, or CANCELLED.
 */
export async function cancelPurchaseOrder(purchaseOrderId: string): Promise<PurchaseOrder> {
  return prisma.$transaction(async (tx) => {
    await lockPurchaseOrder(tx, purchaseOrderId);
    const po = await tx.purchaseOrder.findUnique({ where: { id: purchaseOrderId }, include: { items: true } });
    if (!po) throw new PurchaseOrderNotFoundError(purchaseOrderId);
    if (!CANCELLABLE_STATUSES.has(po.status)) {
      throw new InvalidPurchaseOrderTransitionError(po.status, 'CANCELLED');
    }
    const anyReceived = po.items.some((i) => Number(i.quantityReceived) > 0);
    if (anyReceived) throw new InvalidPurchaseOrderTransitionError(po.status, 'CANCELLED');
    return tx.purchaseOrder.update({ where: { id: purchaseOrderId }, data: { status: 'CANCELLED' } });
  });
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
  /** True when this call found an existing receipt for the given
   * idempotencyKey and returned it unchanged rather than writing anything
   * new — a duplicate submission, not a new receiving event. */
  duplicate: boolean;
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
 * Guards against receiving into the wrong lifecycle stage (Phase 7): only
 * allowed while the order is SENT or PARTIALLY_RECEIVED — see
 * RECEIVABLE_STATUSES.
 *
 * Idempotency (Phase 7): pass a stable `idempotencyKey` (e.g. one generated
 * once by the UI form and reused across retries of the same logical
 * submission) and a repeated call with the same key becomes a no-op that
 * returns the original receipt — `duplicate: true`, nothing written a
 * second time, inventory never double-incremented. Omitting the key
 * preserves the exact prior behavior (no idempotency guarantee) for any
 * caller that doesn't supply one. The check happens inside the same
 * advisory-locked transaction as the over-receipt check, so it's race-free
 * against a concurrent duplicate the same way over-receiving already is;
 * a P2002 on the create (defense in depth, in case two callers ever raced
 * outside that lock) is caught and translated into the same
 * duplicate-receipt result rather than a raw database error.
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
  items: ReceiveGoodsItemInput[],
  idempotencyKey?: string | null
): Promise<ReceiveGoodsResult> {
  return prisma.$transaction(async (tx) => {
    await lockPurchaseOrder(tx, purchaseOrderId);

    if (idempotencyKey) {
      const existing = await tx.goodsReceipt.findUnique({
        where: { idempotencyKey },
        include: { items: true, purchaseOrder: true },
      });
      if (existing) {
        return { receipt: existing, status: existing.purchaseOrder.status, duplicate: true };
      }
    }

    const purchaseOrder = await tx.purchaseOrder.findUnique({
      where: { id: purchaseOrderId },
      include: { items: true },
    });
    if (!purchaseOrder) throw new PurchaseOrderNotFoundError(purchaseOrderId);

    if (!RECEIVABLE_STATUSES.has(purchaseOrder.status)) {
      throw new InvalidPurchaseOrderTransitionError(purchaseOrder.status, 'PARTIALLY_RECEIVED/RECEIVED');
    }

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

    let receipt: GoodsReceipt & { items: GoodsReceiptItem[] };
    try {
      receipt = await tx.goodsReceipt.create({
        data: { purchaseOrderId, warehouseId, idempotencyKey: idempotencyKey || null, items: { create: items } },
        include: { items: true },
      });
    } catch (err) {
      if (idempotencyKey && err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        // Lost a race against a concurrent call with the same key (should
        // be prevented by the advisory lock above in practice — this is
        // defense in depth, not the primary guard).
        const existing = await tx.goodsReceipt.findUniqueOrThrow({
          where: { idempotencyKey },
          include: { items: true, purchaseOrder: true },
        });
        return { receipt: existing, status: existing.purchaseOrder.status, duplicate: true };
      }
      throw err;
    }

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

    return { receipt, status, duplicate: false };
  });
}
