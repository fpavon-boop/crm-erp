import { NextRequest, NextResponse } from 'next/server';
import { requireApiModule } from '@/lib/api-auth';
import { cancelPurchaseOrder, PurchaseOrderNotFoundError, InvalidPurchaseOrderTransitionError } from '@/lib/purchase-orders';
import { logAudit } from '@/lib/audit';

/** Cancels a purchase order (DRAFT or SENT, with nothing received yet, ->
 * CANCELLED). See cancelPurchaseOrder in src/lib/purchase-orders.ts for the
 * exact guard. */
export async function POST(_req: NextRequest, { params }: { params: { id: string } }) {
  const session = await requireApiModule('purchasing');
  if (session instanceof NextResponse) return session;

  let order;
  try {
    order = await cancelPurchaseOrder(params.id);
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
    action: 'PURCHASE_ORDER_CANCELLED',
    entityType: 'PurchaseOrder',
    entityId: order.id,
  });

  return NextResponse.json({ order });
}
