import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { requireApiModule } from '@/lib/api-auth';
import { logAudit } from '@/lib/audit';
import { billImportSchema } from '@/lib/bills';

export async function GET(req: NextRequest) {
  const session = await requireApiModule('finance');
  if (session instanceof NextResponse) return session;

  const status = req.nextUrl.searchParams.get('status');
  const bills = await prisma.billEntry.findMany({
    where: status === 'REVIEW' || status === 'APPROVED' || status === 'REJECTED' ? { status } : undefined,
    orderBy: { createdAt: 'desc' },
    take: 500,
  });
  return NextResponse.json({ bills });
}

/** Bulk import of rows (from a CSV the browser has already parsed). Rows land in the review list. */
export async function POST(req: NextRequest) {
  const session = await requireApiModule('finance');
  if (session instanceof NextResponse) return session;

  const parsed = billImportSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });

  const result = await prisma.billEntry.createMany({
    data: parsed.data.rows.map((r) => ({
      kind: r.kind ?? 'BILL',
      vendor: r.vendor ?? null,
      invoiceNumber: r.invoiceNumber ?? null,
      amount: r.amount,
      billDate: r.billDate ? new Date(r.billDate) : null,
      dueDate: r.dueDate ? new Date(r.dueDate) : null,
      category: r.category ?? null,
      paid: r.paid ?? false,
      paymentMethod: r.paymentMethod ?? null,
      notes: r.notes ?? null,
      source: 'CSV',
      uploadedById: session.user.id,
    })),
  });

  await logAudit({
    userId: session.user.id,
    action: 'BILLS_IMPORTED',
    entityType: 'BillEntry',
    entityId: 'bulk',
    changes: { count: result.count },
  });
  return NextResponse.json({ imported: result.count }, { status: 201 });
}
