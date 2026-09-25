import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { requireApiModule } from '@/lib/api-auth';
import { invoiceSchema } from '@/lib/validation';
import { computeTotals } from '@/lib/totals';
import { generateNumber } from '@/lib/numbering';
import { logAudit } from '@/lib/audit';
import { csvResponse } from '@/lib/csv';
import { money } from '@/lib/format';

export async function GET(req: NextRequest) {
  const session = await requireApiModule('invoicing');
  if (session instanceof NextResponse) return session;

  const { searchParams } = req.nextUrl;
  const status = searchParams.get('status') || undefined;
  const format = searchParams.get('format');

  const invoices = await prisma.invoice.findMany({
    where: status ? { status: status as never } : undefined,
    include: { company: true, contact: true },
    orderBy: { createdAt: 'desc' },
  });

  if (format === 'csv') {
    return csvResponse('invoices.csv', invoices.map((i) => ({
      number: i.number,
      type: i.type,
      company: i.company?.name,
      status: i.status,
      total: money(i.total),
      amountPaid: money(i.amountPaid),
      dueDate: i.dueDate,
      issueDate: i.issueDate,
    })));
  }

  return NextResponse.json({ invoices });
}

export async function POST(req: NextRequest) {
  const session = await requireApiModule('invoicing');
  if (session instanceof NextResponse) return session;

  const body = await req.json();
  const parsed = invoiceSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });

  const { items, dueDate, type, ...rest } = parsed.data;
  const totals = computeTotals(items);
  const kind = type === 'ESTIMATE' ? 'estimate' : type === 'RECEIPT' ? 'receipt' : 'invoice';

  const invoice = await prisma.$transaction(async (tx) => {
    const number = await generateNumber(kind, tx);
    return tx.invoice.create({
      data: {
        ...rest,
        type,
        number,
        ...totals,
        dueDate: dueDate ? new Date(dueDate) : null,
        createdById: session.user.id,
        items: { create: items },
      },
      include: { items: true },
    });
  });

  await logAudit({
    userId: session.user.id,
    action: 'CREATE',
    entityType: 'Invoice',
    entityId: invoice.id,
    companyId: invoice.companyId,
  });

  return NextResponse.json({ invoice }, { status: 201 });
}
