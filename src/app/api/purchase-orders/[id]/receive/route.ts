import { NextRequest, NextResponse } from 'next/server';
import { requireApiModule } from '@/lib/api-auth';
import {
  receiveGoodsForPurchaseOrder,
  PurchaseOrderNotFoundError,
  OverReceiptError,
  InvalidPurchaseOrderTransitionError,
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
  // Optional — see receiveGoodsForPurchaseOrder's "Idempotency" doc comment.
  // The UI form generates one per logical submission and resends it on
  // retry, so a duplicate request (double-click, network retry) is a no-op
  // rather than a second receipt.
  idempotencyKey: z.string().min(1).max(200).optional(),
});

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const session = await requireApiModule('purchasing');
  if (session instanceof NextResponse) return session;

  const body = await req.json();
  const parsed = schema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });

  let result;
  try {
    result = await receiveGoodsForPurchaseOrder(
      params.id,
      parsed.data.warehouseId,
      parsed.data.items,
      parsed.data.idempotencyKey
    );
  } catch (err) {
    if (err instanceof PurchaseOrderNotFoundError) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 });
    }
    if (err instanceof OverReceiptError) {
      return NextResponse.json({ error: err.message, violations: err.violations }, { status: 400 });
    }
    if (err instanceof InvalidPurchaseOrderTransitionError) {
      return NextResponse.json({ error: err.message }, { status: 409 });
    }
    throw err;
  }

  // A duplicate submission changed nothing — don't log a second
  // GOODS_RECEIVED audit entry for an event that didn't actually happen
  // again.
  if (!result.duplicate) {
    await logAudit({
      userId: session.user.id,
      action: 'GOODS_RECEIVED',
      entityType: 'PurchaseOrder',
      entityId: params.id,
    });
  }

  return NextResponse.json(
    { receipt: result.receipt, status: result.status, duplicate: result.duplicate },
    { status: result.duplicate ? 200 : 201 }
  );
}
