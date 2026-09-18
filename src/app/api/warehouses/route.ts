import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { requireApiModule } from '@/lib/api-auth';
import { warehouseSchema } from '@/lib/validation';

export async function GET() {
  const session = await requireApiModule('inventory');
  if (session instanceof NextResponse) return session;
  const warehouses = await prisma.warehouse.findMany({ orderBy: { name: 'asc' } });
  return NextResponse.json({ warehouses });
}

export async function POST(req: NextRequest) {
  const session = await requireApiModule('inventory');
  if (session instanceof NextResponse) return session;

  const body = await req.json();
  const parsed = warehouseSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });

  const warehouse = await prisma.warehouse.create({ data: parsed.data });
  return NextResponse.json({ warehouse }, { status: 201 });
}
