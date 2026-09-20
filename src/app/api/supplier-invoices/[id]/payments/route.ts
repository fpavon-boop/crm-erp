import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import { requireApiModule } from '@/lib/api-auth';
import { logAudit } from '@/lib/audit';

const schema = z.object({
  amount: z.coerce.number().positive(),
  method: z.string().min(1).max(60),
  reference: z.string().max(120).optional().nullable(),
  paidAt: z.string().optional().nullable(),
});

/** Records a payment against a supplier bill and updates its paid amount and status. */
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const session = await requireApiModule('finance');
  if (session instanceof NextResponse) return session;

  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });

  const bill = await prisma.supplierInvoice.findUnique({ where: { id: params.id } });
  if (!bill) return NextResponse.json({ error: 'Bill not found' }, { status: 404 });

  const open = Number(bill.amount) - Number(bill.amountPaid);
  if (parsed.data.amount > open + 0.005) {
    return NextResponse.json({ error: `Payment is more than the open balance (${open.toFixed(2)})` }, { status: 400 });
  }

  const paidAt = parsed.data.paidAt ? new Date(parsed.data.paidAt) : new Date();
  if (Number.isNaN(paidAt.getTime())) return NextResponse.json({ error: 'Invalid date' }, { status: 400 });

  const newPaid = Number(bill.amountPaid) + parsed.data.amount;
  const status = newPaid >= Number(bill.amount) - 0.005 ? 'PAID' : 'PARTIAL';

  const [payment] = await prisma.$transaction([
    prisma.supplierPayment.create({
      data: {
        supplierInvoiceId: bill.id,
        amount: parsed.data.amount,
        method: parsed.data.method,
        reference: parsed.data.reference || null,
        paidAt,
      },
    }),
    prisma.supplierInvoice.update({ where: { id: bill.id }, data: { amountPaid: newPaid, status } }),
  ]);

  await logAudit({
    userId: session.user.id,
    action: 'SUPPLIER_PAYMENT_RECORDED',
    entityType: 'SupplierInvoice',
    entityId: bill.id,
    companyId: bill.supplierId,
    changes: parsed.data,
  });

  return NextResponse.json({ payment, status });
}
