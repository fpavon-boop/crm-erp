import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { requireApiModule } from '@/lib/api-auth';
import { logAudit } from '@/lib/audit';
import { deriveInvoiceStatus } from '@/lib/accounts-receivable';
import { claimIdempotencyKey, recordIdempotentResult } from '@/lib/automations/idempotency';
import { z } from 'zod';

const schema = z.object({
  amount: z.coerce.number().positive(),
  method: z.string().min(1),
  reference: z.string().optional(),
  // Phase 13: a client-generated key so a network retry or double-submit
  // of the same click can never record the same payment twice.
  idempotencyKey: z.string().min(1).max(200).optional(),
});

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const session = await requireApiModule('invoicing');
  if (session instanceof NextResponse) return session;

  const body = await req.json();
  const parsed = schema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  const { idempotencyKey, ...data } = parsed.data;

  if (idempotencyKey) {
    const claim = await claimIdempotencyKey(idempotencyKey, 'invoice_payment');
    if (!claim.claimed) {
      const invoice = await prisma.invoice.findUnique({ where: { id: params.id } });
      return NextResponse.json({ invoice, duplicate: true });
    }
  }

  const updated = await prisma.$transaction(async (tx) => {
    const invoice = await tx.invoice.findUniqueOrThrow({ where: { id: params.id } });
    await tx.payment.create({ data: { invoiceId: invoice.id, ...data } });

    const newPaid = Number(invoice.amountPaid) + data.amount;
    const status = deriveInvoiceStatus({ status: invoice.status, total: Number(invoice.total), amountPaid: newPaid, dueDate: invoice.dueDate });

    return tx.invoice.update({
      where: { id: invoice.id },
      data: { amountPaid: newPaid, status },
    });
  });
  if (idempotencyKey) await recordIdempotentResult(idempotencyKey, updated.id);

  await logAudit({
    userId: session.user.id,
    action: 'PAYMENT_RECORDED',
    entityType: 'Invoice',
    entityId: updated.id,
    companyId: updated.companyId,
    changes: data,
  });

  return NextResponse.json({ invoice: updated });
}
