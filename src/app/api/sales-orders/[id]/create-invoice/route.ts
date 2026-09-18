import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { requireApiModule } from '@/lib/api-auth';
import { generateNumber } from '@/lib/numbering';

export async function POST(_req: NextRequest, { params }: { params: { id: string } }) {
  const session = await requireApiModule('sales');
  if (session instanceof NextResponse) return session;

  const order = await prisma.salesOrder.findUnique({ where: { id: params.id }, include: { items: true } });
  if (!order) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const number = await generateNumber('invoice');
  const invoice = await prisma.invoice.create({
    data: {
      number,
      type: 'INVOICE',
      companyId: order.companyId,
      contactId: order.contactId,
      salesOrderId: order.id,
      subtotal: order.subtotal,
      taxTotal: order.taxTotal,
      discountTotal: order.discountTotal,
      total: order.total,
      dueDate: new Date(Date.now() + 1000 * 60 * 60 * 24 * 30),
      createdById: session.user.id,
      items: {
        create: order.items.map((i) => ({
          productId: i.productId,
          productVariantId: i.productVariantId,
          description: i.description,
          quantity: i.quantity,
          unitPrice: i.unitPrice,
          taxRate: i.taxRate,
          discount: i.discount,
        })),
      },
    },
    include: { items: true },
  });

  return NextResponse.json({ invoice }, { status: 201 });
}
