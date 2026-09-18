import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { requireApiModule } from '@/lib/api-auth';
import { z } from 'zod';

const schema = z.object({
  name: z.string().min(1),
  sku: z.string().min(1),
  priceDelta: z.coerce.number().default(0),
  attributes: z.record(z.string()).optional(),
});

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const session = await requireApiModule('inventory');
  if (session instanceof NextResponse) return session;

  const body = await req.json();
  const parsed = schema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });

  const variant = await prisma.productVariant.create({
    data: { productId: params.id, ...parsed.data },
  });
  return NextResponse.json({ variant }, { status: 201 });
}
