import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { requireApiModule } from '@/lib/api-auth';
import { logAudit } from '@/lib/audit';
import { deleteStoredFile } from '@/lib/uploads';
import { billEditSchema } from '@/lib/bills';

export async function PUT(req: NextRequest, { params }: { params: { id: string } }) {
  const session = await requireApiModule('finance');
  if (session instanceof NextResponse) return session;

  const parsed = billEditSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });

  const existing = await prisma.billEntry.findUnique({ where: { id: params.id } });
  if (!existing) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  if (existing.status === 'APPROVED') {
    return NextResponse.json({ error: 'Approved entries can no longer be edited here' }, { status: 409 });
  }

  const d = parsed.data;
  const bill = await prisma.billEntry.update({
    where: { id: params.id },
    data: {
      ...(d.kind !== undefined ? { kind: d.kind } : {}),
      ...(d.vendor !== undefined ? { vendor: d.vendor || null } : {}),
      ...(d.invoiceNumber !== undefined ? { invoiceNumber: d.invoiceNumber || null } : {}),
      ...(d.amount !== undefined ? { amount: d.amount } : {}),
      ...(d.billDate !== undefined ? { billDate: d.billDate ? new Date(d.billDate) : null } : {}),
      ...(d.dueDate !== undefined ? { dueDate: d.dueDate ? new Date(d.dueDate) : null } : {}),
      ...(d.category !== undefined ? { category: d.category || null } : {}),
      ...(d.paid !== undefined ? { paid: d.paid } : {}),
      ...(d.paymentMethod !== undefined ? { paymentMethod: d.paymentMethod || null } : {}),
      ...(d.notes !== undefined ? { notes: d.notes || null } : {}),
    },
  });
  return NextResponse.json({ bill });
}

export async function DELETE(_req: NextRequest, { params }: { params: { id: string } }) {
  const session = await requireApiModule('finance');
  if (session instanceof NextResponse) return session;

  const existing = await prisma.billEntry.findUnique({ where: { id: params.id } });
  if (!existing) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  if (existing.status === 'APPROVED') {
    return NextResponse.json(
      { error: 'This entry is already in your books. Delete the bill or expense itself instead.' },
      { status: 409 }
    );
  }

  await prisma.billEntry.delete({ where: { id: params.id } });
  if (existing.storedPath) await deleteStoredFile(existing.storedPath);
  await logAudit({
    userId: session.user.id,
    action: 'BILL_ENTRY_DELETED',
    entityType: 'BillEntry',
    entityId: params.id,
    changes: { fileName: existing.fileName, vendor: existing.vendor },
  });
  return NextResponse.json({ ok: true });
}
