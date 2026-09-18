import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { requireApiModule } from '@/lib/api-auth';
import { salesOrderSchema } from '@/lib/validation';
import { computeTotals } from '@/lib/totals';
import { generateNumber } from '@/lib/numbering';
import { logAudit } from '@/lib/audit';
import { csvResponse } from '@/lib/csv';
import { money } from '@/lib/format';

export async function GET(req: NextRequest) {
  const session = await requireApiModule('sales');
  if (session instanceof NextResponse) return session;

  const format = req.nextUrl.searchParams.get('format');
  const orders = await prisma.salesOrder.findMany({
    include: { company: true, contact: true },
    orderBy: { createdAt: 'desc' },
  });

  if (format === 'csv') {
    return csvResponse('sales-orders.csv', orders.map((o) => ({
      number: o.number,
      company: o.company?.name,
      status: o.status,
      total: money(o.total),
      createdAt: o.createdAt,
    })));
  }

  return NextResponse.json({ orders });
}

export async function POST(req: NextRequest) {
  const session = await requireApiModule('sales');
  if (session instanceof NextResponse) return session;

  const body = await req.json();
  const parsed = salesOrderSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });

  const { items, ...rest } = parsed.data;
  const totals = computeTotals(items);
  const number = await generateNumber('salesOrder');

  const order = await prisma.salesOrder.create({
    data: { ...rest, number, ...totals, items: { create: items } },
    include: { items: true },
  });

  await logAudit({
    userId: session.user.id,
    action: 'CREATE',
    entityType: 'SalesOrder',
    entityId: order.id,
    companyId: order.companyId,
  });

  return NextResponse.json({ order }, { status: 201 });
}
