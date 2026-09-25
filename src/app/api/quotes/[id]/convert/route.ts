import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { requireApiModule } from '@/lib/api-auth';
import { generateNumber } from '@/lib/numbering';

/** Converts an accepted quote into a draft sales order, copying its line items. */
export async function POST(_req: NextRequest, { params }: { params: { id: string } }) {
  const session = await requireApiModule('sales');
  if (session instanceof NextResponse) return session;

  const quote = await prisma.quote.findUnique({ where: { id: params.id }, include: { items: true } });
  if (!quote) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const order = await prisma.$transaction(async (tx) => {
    const number = await generateNumber('salesOrder', tx);
    return tx.salesOrder.create({
      data: {
        number,
        companyId: quote.companyId,
        contactId: quote.contactId,
        quoteId: quote.id,
        subtotal: quote.subtotal,
        taxTotal: quote.taxTotal,
        discountTotal: quote.discountTotal,
        total: quote.total,
        items: {
          create: quote.items.map((i) => ({
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
  });

  return NextResponse.json({ order }, { status: 201 });
}
