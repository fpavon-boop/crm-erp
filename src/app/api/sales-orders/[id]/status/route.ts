import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { requireApiModule } from '@/lib/api-auth';
import { applySalesOrderInventoryEffect } from '@/lib/automations/stock';
import { sendOrderConfirmation } from '@/lib/automations/notifications';
import { logAudit } from '@/lib/audit';
import { z } from 'zod';

const schema = z.object({
  status: z.enum(['DRAFT', 'CONFIRMED', 'SHIPPED', 'DELIVERED', 'CANCELLED']),
});

/** Changing a sales order's status is the trigger point for automated
 * inventory movements (confirmed/shipped -> stock out, cancelled -> stock
 * returned) and the automatic order-confirmation email. */
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const session = await requireApiModule('sales');
  if (session instanceof NextResponse) return session;

  const body = await req.json();
  const parsed = schema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });

  const previous = await prisma.salesOrder.findUniqueOrThrow({ where: { id: params.id } });
  const order = await prisma.salesOrder.update({
    where: { id: params.id },
    data: { status: parsed.data.status },
  });

  await logAudit({
    userId: session.user.id,
    action: 'STATUS_CHANGE',
    entityType: 'SalesOrder',
    entityId: order.id,
    companyId: order.companyId,
    changes: { from: previous.status, to: order.status },
  });

  if (parsed.data.status === 'CONFIRMED' || parsed.data.status === 'SHIPPED') {
    if (previous.status !== parsed.data.status) {
      await applySalesOrderInventoryEffect(order.id, parsed.data.status);
    }
  } else if (parsed.data.status === 'CANCELLED' && previous.status !== 'CANCELLED') {
    await applySalesOrderInventoryEffect(order.id, 'CANCELLED');
  }

  if (parsed.data.status === 'CONFIRMED' && previous.status !== 'CONFIRMED') {
    await sendOrderConfirmation(order.id).catch(() => undefined);
  }

  return NextResponse.json({ order });
}
