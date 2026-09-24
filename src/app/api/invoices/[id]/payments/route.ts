import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { requireApiModule } from '@/lib/api-auth';
import { logAudit } from '@/lib/audit';
import { deriveInvoiceStatus } from '@/lib/accounts-receivable';
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

  const updated = await prisma.$transaction(async (tx) => {
    const invoice = await tx.invoice.findUniqueOrThrow({ where: { id: params.id } });
    await tx.payment.create({ data: { invoiceId: invoice.id, ...parsed.data } });

    const newPaid = Number(invoice.amountPaid) + parsed.data.amount;
    const status = deriveInvoiceStatus({ status: invoice.status, total: Number(invoice.total), amountPaid: newPaid, dueDate: invoice.dueDate });

    return tx.invoice.update({
      where: { id: invoice.id },
      data: { amountPaid: newPaid, status },
    });
  });

  await logAudit({
    userId: session.user.id,
    action: 'PAYMENT_RECORDED',
    entityType: 'Invoice',
    entityId: updated.id,
    companyId: updated.companyId,
    changes: parsed.data,
  });

  return NextResponse.json({ invoice: updated });
}
