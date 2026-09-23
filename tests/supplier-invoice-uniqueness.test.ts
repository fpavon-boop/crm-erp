import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { TestDb } from './test-db';
import { startTestDb } from './test-db';

/** Item 1 (Phase 0): SupplierInvoice.number must be unique, both at the
 * database level (migration 20260922180000_supplier_invoice_number_unique)
 * and at the application level (a clear, typed error instead of a raw
 * Prisma crash). */
describe('SupplierInvoice uniqueness', () => {
  let db: TestDb;
  // Imported dynamically per-test after DATABASE_URL points at the test DB,
  // via a scoped PrismaClient passed into the lib function under test.
  let createSupplierInvoiceSafely: typeof import('../src/lib/supplier-invoices')['createSupplierInvoiceSafely'];
  let DuplicateSupplierInvoiceNumberError: typeof import('../src/lib/supplier-invoices')['DuplicateSupplierInvoiceNumberError'];

  beforeAll(async () => {
    db = await startTestDb();
    // The shared `@/lib/prisma` singleton reads DATABASE_URL when it is
    // constructed (at import time), so point it at the test database
    // *before* importing anything that pulls that module in.
    process.env.DATABASE_URL = db.url;
    const mod = await import('../src/lib/supplier-invoices');
    createSupplierInvoiceSafely = mod.createSupplierInvoiceSafely;
    DuplicateSupplierInvoiceNumberError = mod.DuplicateSupplierInvoiceNumberError;
  }, 60000);

  afterAll(async () => {
    await db.stop();
  });

  it('the database itself rejects a second row with the same number', async () => {
    await db.prisma.supplierInvoice.create({ data: { number: 'BILL-DUP-1', amount: 100 } });
    await expect(
      db.prisma.supplierInvoice.create({ data: { number: 'BILL-DUP-1', amount: 200 } })
    ).rejects.toMatchObject({ code: 'P2002' });
  });

  it('createSupplierInvoiceSafely creates a bill with a unique number', async () => {
    const bill = await createSupplierInvoiceSafely({ number: 'BILL-UNIQUE-1', amount: 50 });
    expect(bill.number).toBe('BILL-UNIQUE-1');
    const found = await db.prisma.supplierInvoice.findUnique({ where: { number: 'BILL-UNIQUE-1' } });
    expect(found).not.toBeNull();
  });

  it('createSupplierInvoiceSafely throws a clear, typed error on a duplicate number instead of a raw crash', async () => {
    await createSupplierInvoiceSafely({ number: 'BILL-UNIQUE-2', amount: 10 });
    await expect(createSupplierInvoiceSafely({ number: 'BILL-UNIQUE-2', amount: 999 })).rejects.toBeInstanceOf(
      DuplicateSupplierInvoiceNumberError
    );

    // And the second attempt must not have created a duplicate or corrupted the first row.
    const rows = await db.prisma.supplierInvoice.findMany({ where: { number: 'BILL-UNIQUE-2' } });
    expect(rows).toHaveLength(1);
    expect(Number(rows[0].amount)).toBe(10);
  });
});
