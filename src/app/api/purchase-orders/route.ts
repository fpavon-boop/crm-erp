import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { requireApiModule } from '@/lib/api-auth';
import { purchaseOrderSchema } from '@/lib/validation';
import { generateNumber } from '@/lib/numbering';

export async function GET() {
  const session = await requireApiModule('purchasing');
  if (session instanceof NextResponse) return session;

  const orders = await prisma.purchaseOrder.findMany({
    include: { supplier: true },
    orderBy: { createdAt: 'desc' },
  });
  return NextResponse.json({ orders });
}

export async function POST(req: NextRequest) {
  const session = await requireApiModule('purchasing');
  if (session instanceof NextResponse) return session;

  const body = await req.json();
  const parsed = purchaseOrderSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });

  const { items, expectedDate, ...rest } = parsed.data;
  const subtotal = items.reduce((s, i) => s + i.quantity * i.unitCost, 0);
  const number = await generateNumber('purchaseOrder');

  const order = await prisma.purchaseOrder.create({
    data: {
      ...rest,
      number,
      subtotal,
      total: subtotal,
      expectedDate: expectedDate ? new Date(expectedDate) : null,
      items: { create: items },
    },
    include: { items: true },
  });

  return NextResponse.json({ order }, { status: 201 });
}
