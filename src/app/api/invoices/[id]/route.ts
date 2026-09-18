import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { requireApiModule } from '@/lib/api-auth';
import { invoiceSchema } from '@/lib/validation';
import { computeTotals } from '@/lib/totals';

export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  const session = await requireApiModule('invoicing');
  if (session instanceof NextResponse) return session;

  const invoice = await prisma.invoice.findUnique({
    where: { id: params.id },
    include: { company: { include: { emails: true, phones: true } }, contact: true, items: true, payments: true, salesOrder: true },
  });
  if (!invoice) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  return NextResponse.json({ invoice });
}

export async function PUT(req: NextRequest, { params }: { params: { id: string } }) {
  const session = await requireApiModule('invoicing');
  if (session instanceof NextResponse) return session;

  const body = await req.json();
  const parsed = invoiceSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });

  const { items, dueDate, ...rest } = parsed.data;
  const totals = computeTotals(items);

  const invoice = await prisma.invoice.update({
    where: { id: params.id },
    data: { ...rest, ...totals, dueDate: dueDate ? new Date(dueDate) : null, items: { deleteMany: {}, create: items } },
    include: { items: true },
  });

  return NextResponse.json({ invoice });
}

export async function DELETE(_req: NextRequest, { params }: { params: { id: string } }) {
  const session = await requireApiModule('invoicing');
  if (session instanceof NextResponse) return session;
  await prisma.invoice.delete({ where: { id: params.id } });
  return NextResponse.json({ ok: true });
}
