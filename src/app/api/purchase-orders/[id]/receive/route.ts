import { NextRequest, NextResponse } from 'next/server';
import { requireApiModule } from '@/lib/api-auth';
import {
  receiveGoodsForPurchaseOrder,
  PurchaseOrderNotFoundError,
  OverReceiptError,
} from '@/lib/purchase-orders';
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

  let result;
  try {
    result = await receiveGoodsForPurchaseOrder(params.id, parsed.data.warehouseId, parsed.data.items);
  } catch (err) {
    if (err instanceof PurchaseOrderNotFoundError) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 });
    }
    if (err instanceof OverReceiptError) {
      return NextResponse.json({ error: err.message, violations: err.violations }, { status: 400 });
    }
    throw err;
  }

  await logAudit({
    userId: session.user.id,
    action: 'GOODS_RECEIVED',
    entityType: 'PurchaseOrder',
    entityId: params.id,
  });

  return NextResponse.json({ receipt: result.receipt, status: result.status }, { status: 201 });
}
