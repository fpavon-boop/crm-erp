import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { requireApiModule } from '@/lib/api-auth';
import { convertQuoteToSalesOrder, InvalidQuoteConversionError, QuoteNotFoundError } from '@/lib/sales-orders';

/** Converts an accepted quote into a draft sales order, copying its line items. */
export async function POST(_req: NextRequest, { params }: { params: { id: string } }) {
  const session = await requireApiModule('sales');
  if (session instanceof NextResponse) return session;

  const quote = await prisma.quote.findUnique({ where: { id: params.id }, include: { items: true } });
  if (!quote) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  try {
    const { order, created } = await convertQuoteToSalesOrder(quote);
    return NextResponse.json({ order, created }, { status: created ? 201 : 200 });
  } catch (err) {
    if (err instanceof QuoteNotFoundError) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 });
    }
    if (err instanceof InvalidQuoteConversionError) {
      return NextResponse.json({ error: err.message }, { status: 409 });
    }
    throw err;
  }
}
