import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { requireApiModule } from '@/lib/api-auth';
import { applyGoodsReceiptInventoryEffect } from '@/lib/automations/stock';
import { logAudit } from '@/lib/audit';
import { z } from 'zod';

const schema = z.object({
  warehouseId: z.string(),
  items: z
    .array(
      z.object({
        purchaseOrderItemId: z.string(),
        productId: z.string().optional().nullable(),
        productVariantId: z.string().optional().nullable(),
        quantity: z.coerce.number().positive(),
      })
    )
    .min(1),
});

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const session = await requireApiModule('purchasing');
  if (session instanceof NextResponse) return session;

  const body = await req.json();
  const parsed = schema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });

  const purchaseOrder = await prisma.purchaseOrder.findUniqueOrThrow({
    where: { id: params.id },
    include: { items: true },
  });

  const receipt = await prisma.goodsReceipt.create({
    data: {
      purchaseOrderId: purchaseOrder.id,
      warehouseId: parsed.data.warehouseId,
      items: { create: parsed.data.items },
    },
    include: { items: true },
  });

  await applyGoodsReceiptInventoryEffect(receipt.id);

  const updatedItems = await prisma.purchaseOrderItem.findMany({ where: { purchaseOrderId: purchaseOrder.id } });
  const fullyReceived = updatedItems.every((i) => Number(i.quantityReceived) >= Number(i.quantity));
  const anyReceived = updatedItems.some((i) => Number(i.quantityReceived) > 0);

  const status = fullyReceived ? 'RECEIVED' : anyReceived ? 'PARTIALLY_RECEIVED' : purchaseOrder.status;
  await prisma.purchaseOrder.update({ where: { id: purchaseOrder.id }, data: { status } });

  await logAudit({
    userId: session.user.id,
    action: 'GOODS_RECEIVED',
    entityType: 'PurchaseOrder',
    entityId: purchaseOrder.id,
  });

  return NextResponse.json({ receipt, status }, { status: 201 });
}
