import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { requireApiModule } from '@/lib/api-auth';
import { quoteSchema } from '@/lib/validation';
import { computeTotals } from '@/lib/totals';
import { generateNumber } from '@/lib/numbering';
import { logAudit } from '@/lib/audit';

export async function GET() {
  const session = await requireApiModule('sales');
  if (session instanceof NextResponse) return session;

  const quotes = await prisma.quote.findMany({
    include: { company: true, contact: true },
    orderBy: { createdAt: 'desc' },
  });
  return NextResponse.json({ quotes });
}

export async function POST(req: NextRequest) {
  const session = await requireApiModule('sales');
  if (session instanceof NextResponse) return session;

  const body = await req.json();
  const parsed = quoteSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });

  const { items, validUntil, ...rest } = parsed.data;
  const totals = computeTotals(items);

  const quote = await prisma.$transaction(async (tx) => {
    const number = await generateNumber('quote', tx);
    return tx.quote.create({
      data: {
        ...rest,
        number,
        ...totals,
        validUntil: validUntil ? new Date(validUntil) : null,
        items: { create: items },
      },
      include: { items: true },
    });
  });

  await logAudit({
    userId: session.user.id,
    action: 'CREATE',
    entityType: 'Quote',
    entityId: quote.id,
    companyId: quote.companyId,
  });

  return NextResponse.json({ quote }, { status: 201 });
}
