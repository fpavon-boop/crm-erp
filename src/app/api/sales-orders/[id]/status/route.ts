import { NextRequest, NextResponse } from 'next/server';
import { requireApiModule } from '@/lib/api-auth';
import { transitionSalesOrderStatus, SalesOrderStatusConflictError } from '@/lib/sales-orders';
import { sendOrderConfirmation } from '@/lib/automations/notifications';
import { logAudit } from '@/lib/audit';
import { z } from 'zod';

const schema = z.object({
  status: z.enum(['DRAFT', 'CONFIRMED', 'SHIPPED', 'DELIVERED', 'CANCELLED']),
});

/** Changing a sales order's status is the trigger point for automated
 * inventory movements (confirmed/shipped -> stock out, cancelled -> stock
 * returned) and the automatic order-confirmation email. The status change
 * and its inventory effect are applied atomically by
 * transitionSalesOrderStatus() so that two concurrent requests (a
 * double-click, a retried request) can never both apply the effect for the
 * same transition — see src/lib/sales-orders.ts. */
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const session = await requireApiModule('sales');
  if (session instanceof NextResponse) return session;

  const body = await req.json();
  const parsed = schema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });

  let result;
  try {
    result = await transitionSalesOrderStatus(params.id, parsed.data.status);
  } catch (err) {
    if (err instanceof SalesOrderStatusConflictError) {
      return NextResponse.json({ error: err.message }, { status: 409 });
    }
    throw err;
  }

  const { order, previousStatus, changed } = result;

  if (changed) {
    await logAudit({
      userId: session.user.id,
      action: 'STATUS_CHANGE',
      entityType: 'SalesOrder',
      entityId: order.id,
      companyId: order.companyId,
      changes: { from: previousStatus, to: order.status },
    });
  }

  if (changed && order.status === 'CONFIRMED') {
    await sendOrderConfirmation(order.id).catch(() => undefined);
  }

  return NextResponse.json({ order });
}
