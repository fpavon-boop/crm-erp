import { NextRequest, NextResponse } from 'next/server';
import { requireApiModule } from '@/lib/api-auth';
import { approvePurchaseOrder, PurchaseOrderNotFoundError, InvalidPurchaseOrderTransitionError } from '@/lib/purchase-orders';
import { logAudit } from '@/lib/audit';

/** Approves and places a purchase order with its supplier (DRAFT -> SENT) —
 * see docs/PURCHASING_AND_RECEIVING.md "Status mapping" for why this one
 * status covers both "Approved" and "Ordered" in the requested lifecycle. */
export async function POST(_req: NextRequest, { params }: { params: { id: string } }) {
  const session = await requireApiModule('purchasing');
  if (session instanceof NextResponse) return session;

  let order;
  try {
    order = await approvePurchaseOrder(params.id);
  } catch (err) {
    if (err instanceof PurchaseOrderNotFoundError) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 });
    }
    if (err instanceof InvalidPurchaseOrderTransitionError) {
      return NextResponse.json({ error: err.message }, { status: 409 });
    }
    throw err;
  }

  await logAudit({
    userId: session.user.id,
    action: 'PURCHASE_ORDER_APPROVED',
    entityType: 'PurchaseOrder',
    entityId: order.id,
  });

  return NextResponse.json({ order });
}
