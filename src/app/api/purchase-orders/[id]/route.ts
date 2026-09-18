import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { requireApiModule } from '@/lib/api-auth';

export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  const session = await requireApiModule('purchasing');
  if (session instanceof NextResponse) return session;

  const order = await prisma.purchaseOrder.findUnique({
    where: { id: params.id },
    include: {
      supplier: true,
      items: { include: { product: true, productVariant: true } },
      goodsReceipts: { include: { items: true }, orderBy: { receivedAt: 'desc' } },
      supplierInvoices: true,
    },
  });
  if (!order) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  return NextResponse.json({ order });
}

export async function DELETE(_req: NextRequest, { params }: { params: { id: string } }) {
  const session = await requireApiModule('purchasing');
  if (session instanceof NextResponse) return session;
  await prisma.purchaseOrder.delete({ where: { id: params.id } });
  return NextResponse.json({ ok: true });
}
