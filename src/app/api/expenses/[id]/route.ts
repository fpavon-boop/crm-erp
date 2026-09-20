import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { requireApiModule } from '@/lib/api-auth';
import { logAudit } from '@/lib/audit';

export async function DELETE(_req: NextRequest, { params }: { params: { id: string } }) {
  const session = await requireApiModule('finance');
  if (session instanceof NextResponse) return session;

  const expense = await prisma.expense.findUnique({ where: { id: params.id } });
  if (!expense) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  await prisma.expense.delete({ where: { id: params.id } });
  await logAudit({
    userId: session.user.id,
    action: 'EXPENSE_DELETED',
    entityType: 'Expense',
    entityId: params.id,
    changes: { category: expense.category, amount: Number(expense.amount) },
  });
  return NextResponse.json({ ok: true });
}
