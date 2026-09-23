import { prisma } from '@/lib/prisma';
import { Prisma } from '@prisma/client';
import type { StockMovementType, SalesOrderStatus } from '@prisma/client';

/** A plain PrismaClient, or the `tx` handed to a `prisma.$transaction(async
 * (tx) => ...)` callback. Every function here accepts an optional `db` of
 * this type so callers that need the inventory effect to be part of a
 * larger atomic transaction (see transitionSalesOrderStatus in
 * `@/lib/sales-orders`) can pass their `tx` through, while callers that
 * don't care (e.g. a standalone manual adjustment) can omit it and get the
 * same standalone-transaction behavior as before. */
export type Db = typeof prisma | Prisma.TransactionClient;

/** Atomically applies `delta` to a StockLevel row, floored at zero, without
 * losing concurrent updates: the increment-and-floor happens server-side in
 * a single UPDATE, not via a read-then-write in application code. Falls
 * back to creating the row (handling a lost create-race against another
 * concurrent caller) when it doesn't exist yet. See docs/INVENTORY_RULES.md
 * ("Concurrency" and "Never negative"). */
async function upsertStockLevelClamped(
  client: Db,
  productVariantId: string,
  warehouseId: string,
  delta: number
) {
  const updated = await client.$executeRaw`
    UPDATE "StockLevel"
    SET quantity = GREATEST(0, quantity + ${delta})
    WHERE "productVariantId" = ${productVariantId} AND "warehouseId" = ${warehouseId}
  `;
  if (updated > 0) return;

  try {
    await client.stockLevel.create({
      data: { productVariantId, warehouseId, quantity: Math.max(delta, 0) },
    });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      // Lost a create race to a concurrent caller inserting the same row
      // first — it exists now, so apply the update instead.
      await client.$executeRaw`
        UPDATE "StockLevel"
        SET quantity = GREATEST(0, quantity + ${delta})
        WHERE "productVariantId" = ${productVariantId} AND "warehouseId" = ${warehouseId}
      `;
    } else {
      throw err;
    }
  }
}

/** Records a stock movement and updates the StockLevel row atomically,
 * never letting StockLevel.quantity go negative regardless of how large an
 * OUT movement is relative to what's on hand. */
export async function recordStockMovement(params: {
  productVariantId: string;
  warehouseId: string;
  type: StockMovementType;
  quantity: number; // always positive; direction is determined by `type`
  reason?: string;
  referenceType?: string;
  referenceId?: string;
  db?: Db;
}) {
  const delta =
    params.type === 'OUT' ? -Math.abs(params.quantity) : Math.abs(params.quantity);

  const run = async (client: Db) => {
    await client.stockMovement.create({
      data: {
        productVariantId: params.productVariantId,
        warehouseId: params.warehouseId,
        type: params.type,
        quantity: params.quantity,
        reason: params.reason,
        referenceType: params.referenceType,
        referenceId: params.referenceId,
      },
    });
    await upsertStockLevelClamped(client, params.productVariantId, params.warehouseId, delta);
  };

  if (params.db) {
    // Already inside an outer transaction (`tx`): run in order, atomic by
    // virtue of that outer transaction.
    await run(params.db);
  } else {
    // Standalone call: give it its own atomic transaction, as before.
    await prisma.$transaction((tx) => run(tx));
  }
}

export async function defaultWarehouseId(db: Db = prisma): Promise<string> {
  const wh = await db.warehouse.findFirst({ where: { isDefault: true } });
  if (wh) return wh.id;
  const any = await db.warehouse.findFirst();
  if (any) return any.id;
  const created = await db.warehouse.create({
    data: { name: 'Main Warehouse', isDefault: true },
  });
  return created.id;
}

/** Whether this sales order currently holds a net stock deduction — i.e.
 * whether the sum of its OUT movements exceeds the sum of its IN movements
 * on the StockMovement ledger. This is NET, not "has an OUT ever been
 * recorded": an order can be deducted, then (via cancellation, or an edit
 * that reconciles inventory — see updateSalesOrderWithInventoryReconciliation
 * in `@/lib/sales-orders`) have that fully reversed and later re-deducted,
 * all while its original OUT movement stays untouched in history. Using net
 * sum rather than raw existence is what makes that safe: the ledger is the
 * single source of truth for "is this order currently holding stock",
 * independent of how many reverse/reapply cycles it has been through. See
 * docs/INVENTORY_RULES.md. */
export async function hasDeductedStock(salesOrderId: string, db: Db): Promise<boolean> {
  const rows = await db.stockMovement.groupBy({
    by: ['type'],
    where: { referenceType: 'SALES_ORDER', referenceId: salesOrderId, type: { in: ['IN', 'OUT'] } },
    _sum: { quantity: true },
  });
  const out = rows.find((r) => r.type === 'OUT')?._sum.quantity ?? 0;
  const inn = rows.find((r) => r.type === 'IN')?._sum.quantity ?? 0;
  return out > inn;
}

export interface TrackedOrderLine {
  productVariantId: string;
  quantity: number;
}

/** Reduces a sales order's items to the ones that actually move inventory
 * (has a variant, and that variant's product tracks inventory), with
 * Decimal quantities coerced to plain numbers. Shared by the status-driven
 * effect and the edit-reconciliation path so both agree on what "the
 * order's current inventory-relevant lines" means. */
export function extractTrackedLines(
  items: Array<{
    productVariantId: string | null;
    quantity: unknown;
    productVariant?: { product: { trackInventory: boolean } } | null;
  }>
): TrackedOrderLine[] {
  const lines: TrackedOrderLine[] = [];
  for (const item of items) {
    if (!item.productVariantId || !item.productVariant?.product.trackInventory) continue;
    lines.push({ productVariantId: item.productVariantId, quantity: Number(item.quantity) });
  }
  return lines;
}

/** Posts one movement per tracked line against a sales order's reference,
 * in the default warehouse. Used both for the normal status-driven effect
 * and for the reverse/reapply steps of an inventory-affecting edit. */
export async function applySalesOrderLineMovements(
  lines: TrackedOrderLine[],
  type: 'IN' | 'OUT',
  opts: { salesOrderId: string; reason: string; db: Db }
) {
  const warehouseId = await defaultWarehouseId(opts.db);
  for (const line of lines) {
    await recordStockMovement({
      productVariantId: line.productVariantId,
      warehouseId,
      type,
      quantity: line.quantity,
      reason: opts.reason,
      referenceType: 'SALES_ORDER',
      referenceId: opts.salesOrderId,
      db: opts.db,
    });
  }
}

/** Statuses at which a sales order holds a stock deduction. CONFIRMED and
 * SHIPPED are the two ways an order can *first* reach a stock-consuming
 * state (see docs/INVENTORY_RULES.md); DELIVERED never deducts on its own
 * but continues to hold whatever was already deducted earlier. */
const STOCK_HOLDING_STATUSES = new Set<SalesOrderStatus>(['CONFIRMED', 'SHIPPED', 'DELIVERED']);

/** Creates OUT movements the first time a sales order reaches a
 * stock-consuming status (CONFIRMED or SHIPPED — see docs/INVENTORY_RULES.md
 * for exactly which one, and why it's determined by the ledger rather than
 * by status name), and reverses them (IN) on cancellation — but only if
 * stock is currently net-deducted. Only touches variants that track
 * inventory. Pass `db` (a `tx` from an outer `prisma.$transaction`) to make
 * this part of a larger atomic operation — see transitionSalesOrderStatus.
 * Safe to call more than once for the same order/event: every path here is
 * a no-op once its condition is already satisfied, so no duplicate
 * StockMovement rows are ever created. */
export async function applySalesOrderInventoryEffect(
  salesOrderId: string,
  event: 'CONFIRMED' | 'SHIPPED' | 'CANCELLED',
  db: Db = prisma
) {
  if (event === 'CONFIRMED' || event === 'SHIPPED') {
    // Inventory leaves the warehouse exactly once, at the first
    // stock-consuming status this order reaches. If it's currently
    // net-deducted already (whether via an earlier CONFIRMED, an earlier
    // SHIPPED reached without going through CONFIRMED, or a prior edit
    // reconciliation that re-deducted it), this is a no-op.
    if (await hasDeductedStock(salesOrderId, db)) return;
  } else if (event === 'CANCELLED') {
    // Nothing to return if nothing is currently held.
    if (!(await hasDeductedStock(salesOrderId, db))) return;
  }

  const order = await db.salesOrder.findUniqueOrThrow({
    where: { id: salesOrderId },
    include: { items: { include: { productVariant: { include: { product: true } } } } },
  });
  const lines = extractTrackedLines(order.items);

  if (event === 'CONFIRMED' || event === 'SHIPPED') {
    await applySalesOrderLineMovements(lines, 'OUT', {
      salesOrderId: order.id,
      reason: `Sales order ${order.number} ${event.toLowerCase()}`,
      db,
    });
  } else {
    await applySalesOrderLineMovements(lines, 'IN', {
      salesOrderId: order.id,
      reason: `Sales order ${order.number} cancelled - stock returned`,
      db,
    });
  }
}

export { STOCK_HOLDING_STATUSES };

/** Creates IN movements when goods are received against a purchase order.
 * Idempotent per receipt: if this receipt's inventory effect was already
 * recorded (identified by `referenceType: 'GOODS_RECEIPT', referenceId:
 * goodsReceiptId` on the ledger), calling this again for the same receipt
 * is a no-op — defense in depth alongside the caller-level protections in
 * `receiveGoodsForPurchaseOrder` (see `@/lib/purchase-orders`). */
export async function applyGoodsReceiptInventoryEffect(goodsReceiptId: string, db: Db = prisma) {
  const alreadyApplied = await db.stockMovement.findFirst({
    where: { referenceType: 'GOODS_RECEIPT', referenceId: goodsReceiptId },
    select: { id: true },
  });
  if (alreadyApplied) return;

  const receipt = await db.goodsReceipt.findUniqueOrThrow({
    where: { id: goodsReceiptId },
    include: { items: true, purchaseOrder: true },
  });
  const warehouseId = receipt.warehouseId || (await defaultWarehouseId(db));

  for (const item of receipt.items) {
    if (!item.productVariantId) continue;
    await recordStockMovement({
      productVariantId: item.productVariantId,
      warehouseId,
      type: 'IN',
      quantity: Number(item.quantity),
      reason: `Goods receipt for PO ${receipt.purchaseOrder.number}`,
      referenceType: 'GOODS_RECEIPT',
      referenceId: receipt.id,
      db,
    });

    if (item.purchaseOrderItemId) {
      await db.purchaseOrderItem.update({
        where: { id: item.purchaseOrderItemId },
        data: { quantityReceived: { increment: item.quantity } },
      });
    }
  }
}
