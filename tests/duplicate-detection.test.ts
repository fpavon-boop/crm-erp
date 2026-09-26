import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { TestDb } from './test-db';
import { startTestDb } from './test-db';

/**
 * Phase 12 (SYSTEM_AUDIT.md G, E5): duplicate detection for manually
 * created Companies/Contacts, and for bulk CSV bill imports. See
 * docs/DATA_QUALITY_AND_IMPORTS.md.
 */
describe('Duplicate detection', () => {
  let db: TestDb;
  let dup: typeof import('../src/lib/duplicate-detection');

  beforeAll(async () => {
    db = await startTestDb();
    process.env.DATABASE_URL = db.url;
    dup = await import('../src/lib/duplicate-detection');
  }, 60000);

  afterAll(async () => {
    await db.stop();
  });

  function id() {
    return Math.random().toString(36).slice(2);
  }

  describe('findPossibleDuplicateCompanies', () => {
    it('finds an exact, case-insensitive name match', async () => {
      const name = `Acme Brick ${id()}`;
      const company = await db.prisma.company.create({ data: { name, type: 'CUSTOMER' } });
      const matches = await dup.findPossibleDuplicateCompanies(name.toUpperCase());
      expect(matches.map((m) => m.id)).toContain(company.id);
    });

    it('matches regardless of Company.type — a CUSTOMER and a SUPPLIER sharing a name are still flagged', async () => {
      const name = `Dual Role Co ${id()}`;
      await db.prisma.company.create({ data: { name, type: 'SUPPLIER' } });
      const matches = await dup.findPossibleDuplicateCompanies(name);
      expect(matches.some((m) => m.type === 'SUPPLIER')).toBe(true);
    });

    it('returns nothing for a genuinely new name', async () => {
      const matches = await dup.findPossibleDuplicateCompanies(`Never Seen Before ${id()}`);
      expect(matches).toEqual([]);
    });

    it('excludeId omits the record being edited from its own duplicate check', async () => {
      const name = `Self Match ${id()}`;
      const company = await db.prisma.company.create({ data: { name, type: 'CUSTOMER' } });
      const matches = await dup.findPossibleDuplicateCompanies(name, company.id);
      expect(matches).toEqual([]);
    });

    it('an empty or whitespace-only name never matches anything', async () => {
      expect(await dup.findPossibleDuplicateCompanies('')).toEqual([]);
      expect(await dup.findPossibleDuplicateCompanies('   ')).toEqual([]);
    });
  });

  describe('findPossibleDuplicateContacts', () => {
    it('finds an exact, case-insensitive email match', async () => {
      const email = `jane-${id()}@example.com`;
      const contact = await db.prisma.contact.create({ data: { firstName: 'Jane', lastName: 'Doe', email } });
      const matches = await dup.findPossibleDuplicateContacts({ email: email.toUpperCase(), firstName: 'Someone', lastName: 'Else' });
      expect(matches.map((m) => m.id)).toContain(contact.id);
    });

    it('falls back to a case-insensitive first+last name match when no email is given', async () => {
      const firstName = `Frank${id()}`;
      const lastName = `Miller${id()}`;
      const contact = await db.prisma.contact.create({ data: { firstName, lastName } });
      const matches = await dup.findPossibleDuplicateContacts({ email: null, firstName: firstName.toUpperCase(), lastName: lastName.toLowerCase() });
      expect(matches.map((m) => m.id)).toContain(contact.id);
    });

    it('an email match takes priority — does not also require the name to match', async () => {
      const email = `priority-${id()}@example.com`;
      const contact = await db.prisma.contact.create({ data: { firstName: 'Original', lastName: 'Name', email } });
      const matches = await dup.findPossibleDuplicateContacts({ email, firstName: 'Completely', lastName: 'Different' });
      expect(matches.map((m) => m.id)).toContain(contact.id);
    });

    it('returns nothing for a genuinely new contact', async () => {
      const matches = await dup.findPossibleDuplicateContacts({ email: `new-${id()}@example.com`, firstName: 'New', lastName: 'Person' });
      expect(matches).toEqual([]);
    });

    it('excludeId omits the record being edited', async () => {
      const email = `editme-${id()}@example.com`;
      const contact = await db.prisma.contact.create({ data: { firstName: 'Edit', lastName: 'Me', email } });
      const matches = await dup.findPossibleDuplicateContacts({ email, firstName: 'Edit', lastName: 'Me' }, contact.id);
      expect(matches).toEqual([]);
    });
  });

  describe('partitionBillImportRows', () => {
    it('a row with no invoice number is always imported (nothing to key a duplicate check on)', async () => {
      const { toImport, duplicates } = await dup.partitionBillImportRows([{ vendor: 'Acme', invoiceNumber: null }]);
      expect(toImport).toHaveLength(1);
      expect(duplicates).toHaveLength(0);
    });

    it('flags a row whose invoice number already exists as a BillEntry (case-insensitively)', async () => {
      const invoiceNumber = `INV-${id()}`;
      await db.prisma.billEntry.create({ data: { invoiceNumber, vendor: 'Existing Vendor', amount: 10 } });

      const { toImport, duplicates } = await dup.partitionBillImportRows([
        { vendor: 'Reimport Attempt', invoiceNumber: invoiceNumber.toLowerCase() },
      ]);
      expect(toImport).toHaveLength(0);
      expect(duplicates).toHaveLength(1);
      expect(duplicates[0].reason).toBe('already_on_file');
    });

    it('flags a row whose invoice number already exists as a SupplierInvoice (an already-approved bill)', async () => {
      const number = `SINV-${id()}`;
      await db.prisma.supplierInvoice.create({ data: { number, amount: 50 } });

      const { toImport, duplicates } = await dup.partitionBillImportRows([{ vendor: 'X', invoiceNumber: number }]);
      expect(toImport).toHaveLength(0);
      expect(duplicates[0].reason).toBe('already_on_file');
    });

    it('flags the second of two rows sharing an invoice number within the same file, keeping the first', async () => {
      const invoiceNumber = `DUPE-${id()}`;
      const { toImport, duplicates } = await dup.partitionBillImportRows([
        { vendor: 'First', invoiceNumber },
        { vendor: 'Second', invoiceNumber },
      ]);
      expect(toImport).toHaveLength(1);
      expect(toImport[0].vendor).toBe('First');
      expect(duplicates).toHaveLength(1);
      expect(duplicates[0].vendor).toBe('Second');
      expect(duplicates[0].reason).toBe('duplicate_in_file');
    });

    it('a mixed batch correctly partitions new rows from both kinds of duplicate', async () => {
      const already = `ALREADY-${id()}`;
      await db.prisma.billEntry.create({ data: { invoiceNumber: already, amount: 5 } });
      const repeated = `REPEAT-${id()}`;
      const fresh = `FRESH-${id()}`;

      const { toImport, duplicates } = await dup.partitionBillImportRows([
        { vendor: 'A', invoiceNumber: already },
        { vendor: 'B', invoiceNumber: repeated },
        { vendor: 'C', invoiceNumber: repeated },
        { vendor: 'D', invoiceNumber: fresh },
        { vendor: 'E', invoiceNumber: null },
      ]);

      expect(toImport.map((r) => r.vendor).sort()).toEqual(['B', 'D', 'E'].sort());
      expect(duplicates.map((d) => d.vendor).sort()).toEqual(['A', 'C'].sort());
    });

    it('an empty rows array returns an empty result without querying anything', async () => {
      const { toImport, duplicates } = await dup.partitionBillImportRows([]);
      expect(toImport).toEqual([]);
      expect(duplicates).toEqual([]);
    });
  });
});
