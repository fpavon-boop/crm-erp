import { prisma } from '@/lib/prisma';
import type { Prisma, StockMovementType } from '@prisma/client';

/** A plain PrismaClient, or the `tx` handed to a `prisma.$transaction(async
 * (tx) => ...)` callback. Every function here accepts an optional `db` of
 * this type so callers that need the inventory effect to be part of a
 * larger atomic transaction (see transitionSalesOrderStatus in
 * `@/lib/sales-orders`) can pass their `tx` through, while callers that
 * don't care (e.g. the goods-receipt route) can omit it and get the same
 * standalone-transaction behavior as before. */
type Db = typeof prisma | Prisma.TransactionClient;

/** Records a stock movement and updates the StockLevel row atomically. */
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
  const client = params.db ?? prisma;

  const createMovement = client.stockMovement.create({
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
  const upsertLevel = client.stockLevel.upsert({
    where: {
      productVariantId_warehouseId: {
        productVariantId: params.productVariantId,
        warehouseId: params.warehouseId,
      },
    },
    create: {
      productVariantId: params.productVariantId,
      warehouseId: params.warehouseId,
      quantity: Math.max(delta, 0),
    },
    update: { quantity: { increment: delta } },
  });

  if (params.db) {
    // Already inside an outer transaction (`tx`): run in order, atomic by
    // virtue of that outer transaction. A nested `$transaction` isn't
    // possible (or needed) here.
    await createMovement;
    await upsertLevel;
  } else {
    // Standalone call: give it its own atomic transaction, as before.
    await prisma.$transaction([createMovement, upsertLevel]);
  }
}

async function defaultWarehouseId(db: Db = prisma): Promise<string> {
  const wh = await db.warehouse.findFirst({ where: { isDefault: true } });
  if (wh) return wh.id;
  const any = await db.warehouse.findFirst();
  if (any) return any.id;
  const created = await db.warehouse.create({
    data: { name: 'Main Warehouse', isDefault: true },
  });
  return created.id;
}

/** Whether stock has already been deducted for this order — the
 * StockMovement ledger is the source of truth (not order.status), because
 * status alone doesn't say whether a stock-consuming status was reached via
 * the normal CONFIRMED-then-SHIPPED path or a direct jump. See
 * docs/INVENTORY_RULES.md. */
async function hasDeductedStock(salesOrderId: string, db: Db): Promise<boolean> {
  const existing = await db.stockMovement.findFirst({
    where: { referenceType: 'SALES_ORDER', referenceId: salesOrderId, type: 'OUT' },
    select: { id: true },
  });
  return existing !== null;
}

/** Creates OUT movements the first time a sales order reaches a
 * stock-consuming status (CONFIRMED or SHIPPED — see docs/INVENTORY_RULES.md
 * for exactly which one, and why it's determined by the ledger rather than
 * by status name), and reverses them (IN) on cancellation — but only if
 * stock was actually deducted in the first place. Only touches variants
 * that track inventory. Pass `db` (a `tx` from an outer
 * `prisma.$transaction`) to make this part of a larger atomic operation —
 * see transitionSalesOrderStatus. Safe to call more than once for the same
 * order/event: every path here is a no-op once its condition is already
 * satisfied, so no duplicate StockMovement rows are ever created. */
export async function applySalesOrderInventoryEffect(
  salesOrderId: string,
  event: 'CONFIRMED' | 'SHIPPED' | 'CANCELLED',
  db: Db = prisma
) {
  if (event === 'CONFIRMED' || event === 'SHIPPED') {
    // Inventory leaves the warehouse exactly once, at the first
    // stock-consuming status this order reaches. If that already happened
    // (whether via an earlier CONFIRMED, or an earlier SHIPPED reached
    // without going through CONFIRMED), this is a no-op.
    if (await hasDeductedStock(salesOrderId, db)) return;
  } else if (event === 'CANCELLED') {
    // Nothing to return if nothing was ever taken.
    if (!(await hasDeductedStock(salesOrderId, db))) return;
  }

  const order = await db.salesOrder.findUniqueOrThrow({
    where: { id: salesOrderId },
    include: { items: { include: { productVariant: { include: { product: true } } } } },
  });

  const warehouseId = await defaultWarehouseId(db);

  for (const item of order.items) {
    if (!item.productVariantId || !item.productVariant?.product.trackInventory) continue;

    if (event === 'CONFIRMED' || event === 'SHIPPED') {
      await recordStockMovement({
        productVariantId: item.productVariantId,
        warehouseId,
        type: 'OUT',
        quantity: Number(item.quantity),
        reason: `Sales order ${order.number} ${event.toLowerCase()}`,
        referenceType: 'SALES_ORDER',
        referenceId: order.id,
        db,
      });
    } else if (event === 'CANCELLED') {
      await recordStockMovement({
        productVariantId: item.productVariantId,
        warehouseId,
        type: 'IN',
        quantity: Number(item.quantity),
        reason: `Sales order ${order.number} cancelled - stock returned`,
        referenceType: 'SALES_ORDER',
        referenceId: order.id,
        db,
      });
    }
  }
}

/** Creates IN movements when goods are received against a purchase order. */
export async function applyGoodsReceiptInventoryEffect(goodsReceiptId: string) {
  const receipt = await prisma.goodsReceipt.findUniqueOrThrow({
    where: { id: goodsReceiptId },
    include: { items: true, purchaseOrder: true },
  });
  const warehouseId = receipt.warehouseId || (await defaultWarehouseId());

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
    });

    if (item.purchaseOrderItemId) {
      await prisma.purchaseOrderItem.update({
        where: { id: item.purchaseOrderItemId },
        data: { quantityReceived: { increment: item.quantity } },
      });
    }
  }
}
