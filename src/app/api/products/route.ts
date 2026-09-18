import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { requireApiModule } from '@/lib/api-auth';
import { productSchema } from '@/lib/validation';
import { csvResponse } from '@/lib/csv';

export async function GET(req: NextRequest) {
  const session = await requireApiModule('inventory');
  if (session instanceof NextResponse) return session;

  const { searchParams } = req.nextUrl;
  const q = searchParams.get('q') || undefined;
  const format = searchParams.get('format');

  const products = await prisma.product.findMany({
    where: q
      ? { OR: [{ name: { contains: q, mode: 'insensitive' } }, { sku: { contains: q, mode: 'insensitive' } }] }
      : undefined,
    include: { variants: { include: { stockLevels: true } } },
    orderBy: { name: 'asc' },
  });

  if (format === 'csv') {
    return csvResponse(
      'products.csv',
      products.map((p) => ({
        sku: p.sku,
        name: p.name,
        category: p.category,
        price: p.price,
        cost: p.cost,
        stock: p.variants.reduce((s, v) => s + v.stockLevels.reduce((ss, l) => ss + l.quantity, 0), 0),
        reorderPoint: p.reorderPoint,
        active: p.active,
      }))
    );
  }

  return NextResponse.json({ products });
}

export async function POST(req: NextRequest) {
  const session = await requireApiModule('inventory');
  if (session instanceof NextResponse) return session;

  const body = await req.json();
  const parsed = productSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });

  const product = await prisma.product.create({
    data: {
      ...parsed.data,
      variants: { create: [{ name: 'Default', sku: `${parsed.data.sku}-default` }] },
    },
    include: { variants: true },
  });

  return NextResponse.json({ product }, { status: 201 });
}
