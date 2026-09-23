import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { requireApiModule } from '@/lib/api-auth';
import { salesOrderSchema } from '@/lib/validation';
import { computeTotals } from '@/lib/totals';
import { updateSalesOrderWithInventoryReconciliation, SalesOrderNotFoundError } from '@/lib/sales-orders';

export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  const session = await requireApiModule('sales');
  if (session instanceof NextResponse) return session;

  const order = await prisma.salesOrder.findUnique({
    where: { id: params.id },
    include: { company: true, contact: true, items: true, invoices: true, quote: true },
  });
  if (!order) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  return NextResponse.json({ order });
}

export async function PUT(req: NextRequest, { params }: { params: { id: string } }) {
  const session = await requireApiModule('sales');
  if (session instanceof NextResponse) return session;

  const body = await req.json();
  const parsed = salesOrderSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });

  const { items, ...rest } = parsed.data;
  const totals = computeTotals(items);

  let updated;
  try {
    updated = await updateSalesOrderWithInventoryReconciliation(params.id, { ...rest, items }, totals);
  } catch (err) {
    if (err instanceof SalesOrderNotFoundError) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 });
    }
    throw err;
  }
  const order = await prisma.salesOrder.findUniqueOrThrow({
    where: { id: updated.id },
    include: { items: true },
  });

  return NextResponse.json({ order });
}

export async function DELETE(_req: NextRequest, { params }: { params: { id: string } }) {
  const session = await requireApiModule('sales');
  if (session instanceof NextResponse) return session;
  await prisma.salesOrder.delete({ where: { id: params.id } });
  return NextResponse.json({ ok: true });
}
