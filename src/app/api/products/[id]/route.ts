import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { requireApiModule } from '@/lib/api-auth';
import { productSchema } from '@/lib/validation';

export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  const session = await requireApiModule('inventory');
  if (session instanceof NextResponse) return session;

  const product = await prisma.product.findUnique({
    where: { id: params.id },
    include: {
      variants: { include: { stockLevels: { include: { warehouse: true } }, movements: { orderBy: { createdAt: 'desc' }, take: 30, include: { warehouse: true } } } },
    },
  });
  if (!product) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  return NextResponse.json({ product });
}

export async function PUT(req: NextRequest, { params }: { params: { id: string } }) {
  const session = await requireApiModule('inventory');
  if (session instanceof NextResponse) return session;

  const body = await req.json();
  const parsed = productSchema.partial().safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });

  const product = await prisma.product.update({ where: { id: params.id }, data: parsed.data });
  return NextResponse.json({ product });
}

export async function DELETE(_req: NextRequest, { params }: { params: { id: string } }) {
  const session = await requireApiModule('inventory');
  if (session instanceof NextResponse) return session;
  await prisma.product.delete({ where: { id: params.id } });
  return NextResponse.json({ ok: true });
}
