import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import { requireApiModule } from '@/lib/api-auth';
import { logAudit } from '@/lib/audit';

const schema = z.object({
  expenseDate: z.string().min(1),
  category: z.string().min(1).max(80),
  payee: z.string().max(200).optional().nullable(),
  description: z.string().max(500).optional().nullable(),
  amount: z.coerce.number().positive(),
  method: z.string().min(1).max(60),
  reference: z.string().max(120).optional().nullable(),
});

export async function GET() {
  const session = await requireApiModule('finance');
  if (session instanceof NextResponse) return session;

  const expenses = await prisma.expense.findMany({ orderBy: { expenseDate: 'desc' }, take: 500 });
  return NextResponse.json({ expenses });
}

export async function POST(req: NextRequest) {
  const session = await requireApiModule('finance');
  if (session instanceof NextResponse) return session;

  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });

  const { expenseDate, ...rest } = parsed.data;
  const date = new Date(expenseDate);
  if (Number.isNaN(date.getTime())) return NextResponse.json({ error: 'Invalid date' }, { status: 400 });

  const expense = await prisma.expense.create({
    data: { ...rest, expenseDate: date, createdById: session.user.id },
  });
  await logAudit({
    userId: session.user.id,
    action: 'EXPENSE_CREATED',
    entityType: 'Expense',
    entityId: expense.id,
    changes: parsed.data,
  });
  return NextResponse.json({ expense }, { status: 201 });
}
