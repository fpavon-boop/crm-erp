import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import { requireApiModule } from '@/lib/api-auth';
import { logAudit } from '@/lib/audit';
import { claimIdempotencyKey, recordIdempotentResult } from '@/lib/automations/idempotency';

const schema = z.object({
  amount: z.coerce.number().positive(),
  method: z.string().min(1).max(60),
  reference: z.string().max(120).optional().nullable(),
  paidAt: z.string().optional().nullable(),
  // Phase 13: a client-generated key so a network retry or double-submit
  // of the same click can never record the same supplier payment twice.
  idempotencyKey: z.string().min(1).max(200).optional(),
});

/** Records a payment against a supplier bill and updates its paid amount and status. */
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const session = await requireApiModule('finance');
  if (session instanceof NextResponse) return session;

  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  const { idempotencyKey, ...data } = parsed.data;

  if (idempotencyKey) {
    const claim = await claimIdempotencyKey(idempotencyKey, 'supplier_payment');
    if (!claim.claimed) {
      const payment = claim.existingResultRef
        ? await prisma.supplierPayment.findUnique({ where: { id: claim.existingResultRef } })
        : null;
      const bill = await prisma.supplierInvoice.findUnique({ where: { id: params.id } });
      return NextResponse.json({ payment, status: bill?.status, duplicate: true });
    }
  }

  const bill = await prisma.supplierInvoice.findUnique({ where: { id: params.id } });
  if (!bill) return NextResponse.json({ error: 'Bill not found' }, { status: 404 });

  const open = Number(bill.amount) - Number(bill.amountPaid);
  if (data.amount > open + 0.005) {
    return NextResponse.json({ error: `Payment is more than the open balance (${open.toFixed(2)})` }, { status: 400 });
  }

  const paidAt = data.paidAt ? new Date(data.paidAt) : new Date();
  if (Number.isNaN(paidAt.getTime())) return NextResponse.json({ error: 'Invalid date' }, { status: 400 });

  const newPaid = Number(bill.amountPaid) + data.amount;
  const status = newPaid >= Number(bill.amount) - 0.005 ? 'PAID' : 'PARTIAL';

  const [payment] = await prisma.$transaction([
    prisma.supplierPayment.create({
      data: {
        supplierInvoiceId: bill.id,
        amount: data.amount,
        method: data.method,
        reference: data.reference || null,
        paidAt,
      },
    }),
    prisma.supplierInvoice.update({ where: { id: bill.id }, data: { amountPaid: newPaid, status } }),
  ]);
  if (idempotencyKey) await recordIdempotentResult(idempotencyKey, payment.id);

  await logAudit({
    userId: session.user.id,
    action: 'SUPPLIER_PAYMENT_RECORDED',
    entityType: 'SupplierInvoice',
    entityId: bill.id,
    companyId: bill.supplierId,
    changes: data,
  });

  return NextResponse.json({ payment, status });
}
