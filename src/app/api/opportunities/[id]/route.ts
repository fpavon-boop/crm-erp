import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { requireApiModule } from '@/lib/api-auth';
import { opportunitySchema } from '@/lib/validation';

export async function PUT(req: NextRequest, { params }: { params: { id: string } }) {
  const session = await requireApiModule('sales');
  if (session instanceof NextResponse) return session;

  const body = await req.json();
  const parsed = opportunitySchema.partial().safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });

  const { expectedCloseDate, ...rest } = parsed.data;
  const opportunity = await prisma.opportunity.update({
    where: { id: params.id },
    data: { ...rest, expectedCloseDate: expectedCloseDate ? new Date(expectedCloseDate) : undefined },
  });
  return NextResponse.json({ opportunity });
}

export async function DELETE(_req: NextRequest, { params }: { params: { id: string } }) {
  const session = await requireApiModule('sales');
  if (session instanceof NextResponse) return session;
  await prisma.opportunity.delete({ where: { id: params.id } });
  return NextResponse.json({ ok: true });
}
