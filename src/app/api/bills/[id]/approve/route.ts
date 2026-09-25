import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { requireApiModule } from '@/lib/api-auth';
import { logAudit } from '@/lib/audit';
import { approveBillEntryAsBill, DuplicateSupplierInvoiceNumberError } from '@/lib/supplier-invoices';

/** Turns a checked entry into a real supplier bill (and payment) or a paid expense. */
export async function POST(_req: NextRequest, { params }: { params: { id: string } }) {
  const session = await requireApiModule('finance');
  if (session instanceof NextResponse) return session;

  const entry = await prisma.billEntry.findUnique({ where: { id: params.id } });
  if (!entry) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  if (entry.status !== 'REVIEW') return NextResponse.json({ error: 'Already handled' }, { status: 409 });

  const amount = entry.amount === null ? null : Number(entry.amount);
  if (amount === null || !(amount > 0)) {
    return NextResponse.json({ error: 'Enter the amount before approving.' }, { status: 400 });
  }
  const vendor = entry.vendor?.trim();
  if (!vendor) return NextResponse.json({ error: 'Enter who the bill is from before approving.' }, { status: 400 });

  const billDate = entry.billDate ?? new Date();

  if (entry.kind === 'EXPENSE') {
    const expense = await prisma.expense.create({
      data: {
        expenseDate: billDate,
        category: entry.category?.trim() || 'Other',
        payee: vendor,
        description: entry.notes ?? entry.fileName ?? null,
        amount,
        method: entry.paymentMethod || 'Bank transfer',
        reference: entry.invoiceNumber ?? null,
        createdById: session.user.id,
      },
    });
    await prisma.billEntry.update({
      where: { id: entry.id },
      data: { status: 'APPROVED', expenseId: expense.id, paid: true },
    });
    await logAudit({
      userId: session.user.id,
      action: 'BILL_ENTRY_APPROVED',
      entityType: 'Expense',
      entityId: expense.id,
      changes: { fromEntry: entry.id, amount },
    });
    return NextResponse.json({ kind: 'EXPENSE', id: expense.id });
  }

  // BILL: find (or create) the supplier, create the invoice, and mark the
  // entry approved — all atomically (SYSTEM_AUDIT.md D5). See
  // approveBillEntryAsBill's doc comment for exactly what this guards
  // against.
  let bill;
  try {
    bill = await approveBillEntryAsBill({
      billEntryId: entry.id,
      vendor,
      amount,
      paid: entry.paid,
      paymentMethod: entry.paymentMethod,
      invoiceNumber: entry.invoiceNumber,
      billDate,
      dueDate: entry.dueDate,
    });
  } catch (err) {
    if (err instanceof DuplicateSupplierInvoiceNumberError) {
      return NextResponse.json(
        { error: `${err.message} Check the invoice number on this entry (it may already be recorded), then try again.` },
        { status: 409 }
      );
    }
    throw err;
  }
  await logAudit({
    userId: session.user.id,
    action: 'BILL_ENTRY_APPROVED',
    entityType: 'SupplierInvoice',
    entityId: bill.id,
    companyId: bill.supplierId,
    changes: { fromEntry: entry.id, amount, paid: entry.paid },
  });
  return NextResponse.json({ kind: 'BILL', id: bill.id });
}
