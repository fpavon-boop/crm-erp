import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { requireApiModule } from '@/lib/api-auth';
import { quoteSchema } from '@/lib/validation';
import { computeTotals } from '@/lib/totals';

export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  const session = await requireApiModule('sales');
  if (session instanceof NextResponse) return session;

  const quote = await prisma.quote.findUnique({
    where: { id: params.id },
    include: { company: true, contact: true, items: true, salesOrders: true },
  });
  if (!quote) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  return NextResponse.json({ quote });
}

export async function PUT(req: NextRequest, { params }: { params: { id: string } }) {
  const session = await requireApiModule('sales');
  if (session instanceof NextResponse) return session;

  const body = await req.json();
  const parsed = quoteSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });

  const { items, validUntil, ...rest } = parsed.data;
  const totals = computeTotals(items);

  const quote = await prisma.quote.update({
    where: { id: params.id },
    data: {
      ...rest,
      ...totals,
      validUntil: validUntil ? new Date(validUntil) : null,
      items: { deleteMany: {}, create: items },
    },
    include: { items: true },
  });

  return NextResponse.json({ quote });
}

export async function DELETE(_req: NextRequest, { params }: { params: { id: string } }) {
  const session = await requireApiModule('sales');
  if (session instanceof NextResponse) return session;
  await prisma.quote.delete({ where: { id: params.id } });
  return NextResponse.json({ ok: true });
}
