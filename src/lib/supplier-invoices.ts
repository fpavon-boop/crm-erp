import { Prisma, SupplierInvoiceStatus } from '@prisma/client';
import { prisma } from '@/lib/prisma';

type Db = typeof prisma | Prisma.TransactionClient;

/** Thrown when a SupplierInvoice.number collides with an existing bill.
 * Callers should catch this and return a clear 409, not a raw 500. */
export class DuplicateSupplierInvoiceNumberError extends Error {
  constructor(public readonly number: string) {
    super(`A supplier bill with number "${number}" already exists.`);
    this.name = 'DuplicateSupplierInvoiceNumberError';
  }
}

export interface CreateSupplierInvoiceInput {
  number: string;
  supplierId?: string | null;
  purchaseOrderId?: string | null;
  amount: number;
  amountPaid?: number;
  status?: SupplierInvoiceStatus;
  issueDate?: Date;
  dueDate?: Date | null;
}

function isUniqueNumberViolation(err: unknown): boolean {
  return (
    err instanceof Prisma.PrismaClientKnownRequestError &&
    err.code === 'P2002' &&
    Array.isArray((err.meta as { target?: unknown })?.target) &&
    ((err.meta as { target: unknown[] }).target as unknown[]).includes('number')
  );
}

/** Creates a SupplierInvoice, translating a duplicate-number collision
 * (relies on the `SupplierInvoice.number` unique constraint) into a clear,
 * typed error instead of letting a raw Prisma P2002 reach the caller. Pass
 * `db` (a `tx` from an outer `prisma.$transaction`) to make this part of a
 * larger atomic operation — see `approveBillEntryAsBill` below, which needs
 * this create, an optional SupplierPayment create, and a BillEntry update
 * to all succeed or all roll back together (SYSTEM_AUDIT.md D5). */
export async function createSupplierInvoiceSafely(input: CreateSupplierInvoiceInput, db: Db = prisma) {
  try {
    return await db.supplierInvoice.create({ data: input });
  } catch (err) {
    if (isUniqueNumberViolation(err)) {
      throw new DuplicateSupplierInvoiceNumberError(input.number);
    }
    throw err;
  }
}

export interface ApproveBillEntryInput {
  billEntryId: string;
  vendor: string;
  amount: number;
  paid: boolean;
  paymentMethod: string | null;
  invoiceNumber: string | null;
  billDate: Date;
  dueDate: Date | null;
}

/**
 * Turns a reviewed `BillEntry` (kind `BILL`) into a real `SupplierInvoice`
 * — finding or creating the supplier `Company` by name, creating the
 * invoice, recording a `SupplierPayment` if it was already marked paid,
 * and marking the entry `APPROVED` — all inside one `prisma.$transaction`
 * (SYSTEM_AUDIT.md D5). Before this phase these were up to four separate,
 * unguarded writes: a crash or connection drop between them could leave a
 * bill recorded as unpaid when it was actually paid, a payment row with no
 * matching invoice, or a `BillEntry` stuck in `REVIEW` after its bill (and
 * possibly its new supplier `Company`) had already been created — any
 * retry of the approval would then create a *second* supplier/invoice for
 * the same entry. Now either everything commits together or nothing does,
 * and a duplicate invoice number rolls back the supplier-company lookup/
 * create too, so retrying with a corrected number never leaves an orphan
 * `Company` behind from the failed attempt.
 *
 * Throws `DuplicateSupplierInvoiceNumberError` (propagated from
 * `createSupplierInvoiceSafely`) if the resolved invoice number is already
 * in use — callers should translate that into a 409, not a raw 500.
 */
export async function approveBillEntryAsBill(input: ApproveBillEntryInput) {
  const number = input.invoiceNumber?.trim() || `BILL-${input.billEntryId.slice(-6).toUpperCase()}`;

  return prisma.$transaction(async (tx) => {
    let supplier = await tx.company.findFirst({
      where: { name: { equals: input.vendor, mode: 'insensitive' } },
      select: { id: true },
    });
    if (!supplier) {
      supplier = await tx.company.create({ data: { name: input.vendor, type: 'SUPPLIER' }, select: { id: true } });
    }

    const created = await createSupplierInvoiceSafely(
      {
        number,
        supplierId: supplier.id,
        amount: input.amount,
        amountPaid: input.paid ? input.amount : 0,
        status: input.paid ? 'PAID' : 'UNPAID',
        issueDate: input.billDate,
        dueDate: input.dueDate,
      },
      tx
    );

    if (input.paid) {
      await tx.supplierPayment.create({
        data: {
          supplierInvoiceId: created.id,
          amount: input.amount,
          method: input.paymentMethod || 'Bank transfer',
          reference: input.invoiceNumber ?? null,
          paidAt: input.billDate,
        },
      });
    }

    await tx.billEntry.update({
      where: { id: input.billEntryId },
      data: { status: 'APPROVED', supplierInvoiceId: created.id },
    });

    return created;
  });
}
