import { NextRequest, NextResponse } from 'next/server';
import { requireApiModule } from '@/lib/api-auth';
import { createInvoiceForSalesOrder, SalesOrderNotFoundError } from '@/lib/sales-orders';

/** Idempotent: if this order already has an invoice, that same invoice is
 * returned (with 200, not 201) instead of creating a second one — see
 * createInvoiceForSalesOrder() for why (a double-click or retried request
 * used to create duplicate invoices). */
export async function POST(_req: NextRequest, { params }: { params: { id: string } }) {
  const session = await requireApiModule('sales');
  if (session instanceof NextResponse) return session;

  try {
    const { invoice, created } = await createInvoiceForSalesOrder(params.id, session.user.id);
    return NextResponse.json({ invoice, created }, { status: created ? 201 : 200 });
  } catch (err) {
    if (err instanceof SalesOrderNotFoundError) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 });
    }
    throw err;
  }
}
