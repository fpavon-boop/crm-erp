import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { requireApiModule } from '@/lib/api-auth';
import { opportunitySchema } from '@/lib/validation';

export async function GET() {
  const session = await requireApiModule('sales');
  if (session instanceof NextResponse) return session;

  const opportunities = await prisma.opportunity.findMany({
    include: { company: true, contact: true, owner: true },
    orderBy: { createdAt: 'desc' },
  });
  return NextResponse.json({ opportunities });
}

export async function POST(req: NextRequest) {
  const session = await requireApiModule('sales');
  if (session instanceof NextResponse) return session;

  const body = await req.json();
  const parsed = opportunitySchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });

  const { expectedCloseDate, ...rest } = parsed.data;
  const opportunity = await prisma.opportunity.create({
    data: { ...rest, expectedCloseDate: expectedCloseDate ? new Date(expectedCloseDate) : null },
  });
  return NextResponse.json({ opportunity }, { status: 201 });
}
