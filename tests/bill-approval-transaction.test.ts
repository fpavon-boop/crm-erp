import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { TestDb } from './test-db';
import { startTestDb } from './test-db';

/**
 * Phase 8 (SYSTEM_AUDIT.md D5): approveBillEntryAsBill() wraps finding/
 * creating the supplier, creating the SupplierInvoice, recording a
 * SupplierPayment (if already paid), and marking the BillEntry approved
 * in one transaction. Before this phase these were separate, unguarded
 * writes — a duplicate invoice number (or any other failure) partway
 * through could leave a newly-created supplier Company behind with
 * nothing pointing at it, or a BillEntry stuck in REVIEW after its bill
 * had already been created. See src/lib/supplier-invoices.ts.
 */
describe('approveBillEntryAsBill', () => {
  let db: TestDb;
  let approveBillEntryAsBill: typeof import('../src/lib/supplier-invoices')['approveBillEntryAsBill'];
  let DuplicateSupplierInvoiceNumberError: typeof import('../src/lib/supplier-invoices')['DuplicateSupplierInvoiceNumberError'];

  beforeAll(async () => {
    db = await startTestDb();
    process.env.DATABASE_URL = db.url;
    const mod = await import('../src/lib/supplier-invoices');
    approveBillEntryAsBill = mod.approveBillEntryAsBill;
    DuplicateSupplierInvoiceNumberError = mod.DuplicateSupplierInvoiceNumberError;
  }, 60000);

  afterAll(async () => {
    await db.stop();
  });

  async function makeReviewEntry(overrides: { paid?: boolean; invoiceNumber?: string | null } = {}) {
    return db.prisma.billEntry.create({
      data: {
        status: 'REVIEW',
        kind: 'BILL',
        vendor: `Vendor ${Math.random().toString(36).slice(2)}`,
        amount: 250,
        invoiceNumber: overrides.invoiceNumber ?? null,
        paid: overrides.paid ?? false,
        paymentMethod: 'Bank transfer',
      },
    });
  }

  it('approving an unpaid bill: creates the supplier, the invoice as UNPAID, and marks the entry APPROVED — no payment row', async () => {
    const entry = await makeReviewEntry({ paid: false, invoiceNumber: 'INV-A-001' });

    const bill = await approveBillEntryAsBill({
      billEntryId: entry.id,
      vendor: entry.vendor!,
      amount: 250,
      paid: false,
      paymentMethod: null,
      invoiceNumber: entry.invoiceNumber,
      billDate: new Date(),
      dueDate: null,
    });

    expect(bill.status).toBe('UNPAID');
    expect(Number(bill.amountPaid)).toBe(0);

    const supplier = await db.prisma.company.findUnique({ where: { id: bill.supplierId! } });
    expect(supplier?.name).toBe(entry.vendor);
    expect(supplier?.type).toBe('SUPPLIER');

    const payments = await db.prisma.supplierPayment.findMany({ where: { supplierInvoiceId: bill.id } });
    expect(payments).toHaveLength(0);

    const updatedEntry = await db.prisma.billEntry.findUniqueOrThrow({ where: { id: entry.id } });
    expect(updatedEntry.status).toBe('APPROVED');
    expect(updatedEntry.supplierInvoiceId).toBe(bill.id);
  });

  it('approving an already-paid bill: creates the invoice as PAID AND a matching SupplierPayment, atomically', async () => {
    const entry = await makeReviewEntry({ paid: true, invoiceNumber: 'INV-A-002' });

    const bill = await approveBillEntryAsBill({
      billEntryId: entry.id,
      vendor: entry.vendor!,
      amount: 250,
      paid: true,
      paymentMethod: 'Check',
      invoiceNumber: entry.invoiceNumber,
      billDate: new Date(),
      dueDate: null,
    });

    expect(bill.status).toBe('PAID');
    expect(Number(bill.amountPaid)).toBe(250);

    const payments = await db.prisma.supplierPayment.findMany({ where: { supplierInvoiceId: bill.id } });
    expect(payments).toHaveLength(1);
    expect(Number(payments[0].amount)).toBe(250);
    expect(payments[0].method).toBe('Check');
  });

  it('reuses an existing supplier Company (case-insensitive name match) instead of creating a duplicate', async () => {
    const existingSupplier = await db.prisma.company.create({ data: { name: 'Acme Materials', type: 'SUPPLIER' } });
    const entry = await makeReviewEntry({ invoiceNumber: 'INV-A-003' });

    const bill = await approveBillEntryAsBill({
      billEntryId: entry.id,
      vendor: 'acme materials', // different case
      amount: 100,
      paid: false,
      paymentMethod: null,
      invoiceNumber: entry.invoiceNumber,
      billDate: new Date(),
      dueDate: null,
    });

    expect(bill.supplierId).toBe(existingSupplier.id);
    const allWithThatName = await db.prisma.company.findMany({ where: { name: { equals: 'Acme Materials', mode: 'insensitive' } } });
    expect(allWithThatName).toHaveLength(1); // no duplicate created
  });

  it('a duplicate invoice number rolls back EVERYTHING — no orphan supplier Company, no orphan payment, BillEntry stays REVIEW (the core D5 regression test)', async () => {
    // A prior, unrelated bill already used this number.
    await db.prisma.supplierInvoice.create({ data: { number: 'INV-DUP-001', amount: 50 } });

    const entry = await makeReviewEntry({ paid: true, invoiceNumber: 'INV-DUP-001' });
    const brandNewVendorName = `Never-seen-before Vendor ${Math.random().toString(36).slice(2)}`;

    await expect(
      approveBillEntryAsBill({
        billEntryId: entry.id,
        vendor: brandNewVendorName,
        amount: 300,
        paid: true,
        paymentMethod: 'Cash',
        invoiceNumber: entry.invoiceNumber,
        billDate: new Date(),
        dueDate: null,
      })
    ).rejects.toBeInstanceOf(DuplicateSupplierInvoiceNumberError);

    // The whole transaction rolled back: the supplier Company that would
    // have been created for this brand-new vendor name must not exist —
    // without the transaction wrap, this is exactly the orphan D5 warns
    // about (a real vendor Company created, then never linked to anything
    // because the invoice create failed after it).
    const orphanCheck = await db.prisma.company.findFirst({ where: { name: brandNewVendorName } });
    expect(orphanCheck).toBeNull();

    // No SupplierPayment was created for the failed attempt.
    const allPaymentsForDupNumber = await db.prisma.supplierPayment.findMany({
      where: { supplierInvoice: { number: 'INV-DUP-001' } },
    });
    expect(allPaymentsForDupNumber).toHaveLength(0);

    // The entry itself is untouched — still REVIEW, retryable with a
    // corrected number.
    const stillReview = await db.prisma.billEntry.findUniqueOrThrow({ where: { id: entry.id } });
    expect(stillReview.status).toBe('REVIEW');
    expect(stillReview.supplierInvoiceId).toBeNull();
  });

  it('retrying after a duplicate-number failure, with a corrected number, succeeds cleanly', async () => {
    await db.prisma.supplierInvoice.create({ data: { number: 'INV-DUP-002', amount: 50 } });
    const entry = await makeReviewEntry({ invoiceNumber: 'INV-DUP-002' });

    await expect(
      approveBillEntryAsBill({
        billEntryId: entry.id,
        vendor: entry.vendor!,
        amount: 100,
        paid: false,
        paymentMethod: null,
        invoiceNumber: entry.invoiceNumber,
        billDate: new Date(),
        dueDate: null,
      })
    ).rejects.toBeInstanceOf(DuplicateSupplierInvoiceNumberError);

    const retry = await approveBillEntryAsBill({
      billEntryId: entry.id,
      vendor: entry.vendor!,
      amount: 100,
      paid: false,
      paymentMethod: null,
      invoiceNumber: 'INV-DUP-002-CORRECTED',
      billDate: new Date(),
      dueDate: null,
    });

    expect(retry.number).toBe('INV-DUP-002-CORRECTED');
    // Exactly one supplier Company for this vendor — the failed first
    // attempt never left a duplicate behind for the retry to pile onto.
    const suppliers = await db.prisma.company.findMany({ where: { name: entry.vendor! } });
    expect(suppliers).toHaveLength(1);
  });
});
