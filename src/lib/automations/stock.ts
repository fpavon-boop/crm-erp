import { prisma } from '@/lib/prisma';
import type { StockMovementType } from '@prisma/client';

/** Records a stock movement and updates the StockLevel row atomically. */
export async function recordStockMovement(params: {
  productVariantId: string;
  warehouseId: string;
  type: StockMovementType;
  quantity: number; // always positive; direction is determined by `type`
  reason?: string;
  referenceType?: string;
  referenceId?: string;
}) {
  const delta =
    params.type === 'OUT' ? -Math.abs(params.quantity) : Math.abs(params.quantity);

  await prisma.$transaction([
    prisma.stockMovement.create({
      data: {
        productVariantId: params.productVariantId,
        warehouseId: params.warehouseId,
        type: params.type,
        quantity: params.quantity,
        reason: params.reason,
        referenceType: params.referenceType,
        referenceId: params.referenceId,
      },
    }),
    prisma.stockLevel.upsert({
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
    }),
  ]);
}

async function defaultWarehouseId(): Promise<string> {
  const wh = await prisma.warehouse.findFirst({ where: { isDefault: true } });
  if (wh) return wh.id;
  const any = await prisma.warehouse.findFirst();
  if (any) return any.id;
  const created = await prisma.warehouse.create({
    data: { name: 'Main Warehouse', isDefault: true },
  });
  return created.id;
}

/** Creates OUT movements for a confirmed/shipped sales order, and reverses
 * them (IN) on cancellation. Only touches variants that track inventory. */
export async function applySalesOrderInventoryEffect(
  salesOrderId: string,
  event: 'CONFIRMED' | 'SHIPPED' | 'CANCELLED'
) {
  const order = await prisma.salesOrder.findUniqueOrThrow({
    where: { id: salesOrderId },
    include: { items: { include: { productVariant: { include: { product: true } } } } },
  });

  const warehouseId = await defaultWarehouseId();

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
