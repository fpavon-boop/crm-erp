import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { requireApiModule } from '@/lib/api-auth';
import { logAudit } from '@/lib/audit';
import { z } from 'zod';

const schema = z.object({
  amount: z.coerce.number().positive(),
  method: z.string().min(1),
  reference: z.string().optional(),
});

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const session = await requireApiModule('invoicing');
  if (session instanceof NextResponse) return session;

  const body = await req.json();
  const parsed = schema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });

  const invoice = await prisma.invoice.findUniqueOrThrow({ where: { id: params.id } });
  await prisma.payment.create({ data: { invoiceId: invoice.id, ...parsed.data } });

  const newPaid = Number(invoice.amountPaid) + parsed.data.amount;
  const status = newPaid >= Number(invoice.total) ? 'PAID' : 'PARTIAL';

  const updated = await prisma.invoice.update({
    where: { id: invoice.id },
    data: { amountPaid: newPaid, status },
  });

  await logAudit({
    userId: session.user.id,
    action: 'PAYMENT_RECORDED',
    entityType: 'Invoice',
    entityId: invoice.id,
    companyId: invoice.companyId,
    changes: parsed.data,
  });

  return NextResponse.json({ invoice: updated });
}
