import { Prisma, SupplierInvoiceStatus } from '@prisma/client';
import { prisma } from '@/lib/prisma';

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
 * typed error instead of letting a raw Prisma P2002 reach the caller. */
export async function createSupplierInvoiceSafely(input: CreateSupplierInvoiceInput) {
  try {
    return await prisma.supplierInvoice.create({ data: input });
  } catch (err) {
    if (isUniqueNumberViolation(err)) {
      throw new DuplicateSupplierInvoiceNumberError(input.number);
    }
    throw err;
  }
}
