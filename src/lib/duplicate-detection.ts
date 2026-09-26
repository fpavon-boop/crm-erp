import { prisma } from '@/lib/prisma';

/**
 * Manual-entry duplicate detection for Company/Contact creation (Phase 12,
 * SYSTEM_AUDIT.md G). The WooCommerce sync path (`resolveOrderCustomer()`
 * in src/lib/wordpress/woocommerce.ts) has always matched guest/customer
 * records this same way — case-insensitive name for a Company, case-
 * insensitive email for a Contact — before creating one; the manual
 * "New Company"/"New Contact" forms never had an equivalent check. This
 * reuses that exact matching logic rather than inventing a second one.
 *
 * This is a *warning*, not a hard block: `POST /api/companies`/`POST
 * /api/contacts` return the match(es) found instead of creating, and the
 * form surfaces them with a "Create anyway" option — the human decides,
 * the same "no automatic action without a human in the loop" principle
 * Phase 10's communication-sending already established. Nothing here
 * prevents a legitimately distinct company/contact that happens to share a
 * name/email from being created; it only makes the collision visible
 * first. See docs/DATA_QUALITY_AND_IMPORTS.md.
 */

export interface DuplicateCompanyMatch {
  id: string;
  name: string;
  type: string;
}

/** Case-insensitive exact name match against every existing Company —
 * regardless of `type`, since the same real-world company name showing up
 * twice is worth flagging even if one row is typed CUSTOMER and the other
 * SUPPLIER. `excludeId` lets an edit-in-place check exclude the record
 * being edited (not currently used by the create-only routes, but kept for
 * symmetry with findPossibleDuplicateContact and any future edit-time use). */
export async function findPossibleDuplicateCompanies(name: string, excludeId?: string): Promise<DuplicateCompanyMatch[]> {
  const trimmed = name.trim();
  if (!trimmed) return [];
  return prisma.company.findMany({
    where: {
      name: { equals: trimmed, mode: 'insensitive' },
      ...(excludeId ? { id: { not: excludeId } } : {}),
    },
    select: { id: true, name: true, type: true },
    take: 5,
  });
}

export interface DuplicateContactMatch {
  id: string;
  firstName: string;
  lastName: string;
  email: string | null;
  companyId: string | null;
}

/**
 * Matches primarily by case-insensitive email (the strong, precedented
 * signal — the same one `resolveOrderCustomer()` uses). When no email is
 * given at all (a real, common case for a phone-only contact), falls back
 * to an exact case-insensitive first+last name match — a weaker signal,
 * but better than no check at all for the contacts that can't be checked
 * by email.
 */
export async function findPossibleDuplicateContacts(
  input: { email?: string | null; firstName: string; lastName: string },
  excludeId?: string
): Promise<DuplicateContactMatch[]> {
  const email = input.email?.trim();
  const where = email
    ? { email: { equals: email, mode: 'insensitive' as const } }
    : {
        firstName: { equals: input.firstName.trim(), mode: 'insensitive' as const },
        lastName: { equals: input.lastName.trim(), mode: 'insensitive' as const },
      };

  return prisma.contact.findMany({
    where: { ...where, ...(excludeId ? { id: { not: excludeId } } : {}) },
    select: { id: true, firstName: true, lastName: true, email: true, companyId: true },
    take: 5,
  });
}

// =============================================================================
// Bulk CSV bill import duplicate detection (SYSTEM_AUDIT.md E5)
// =============================================================================

export interface BillImportRow {
  invoiceNumber?: string | null;
  vendor?: string | null;
  [key: string]: unknown;
}

export interface BillImportDuplicate {
  invoiceNumber: string;
  vendor: string | null;
  reason: 'already_on_file' | 'duplicate_in_file';
}

/**
 * Splits a batch of CSV bill-import rows into ones safe to insert and ones
 * that look like a re-import of something already on file — checked
 * against both existing `BillEntry` rows (any review status: a bill
 * already waiting for review, already approved, or already rejected is
 * still "already imported") and existing `SupplierInvoice.number` (an
 * already-approved, already-posted bill). Matching is case-insensitive —
 * a stricter, exact match would miss the common case of the same invoice
 * number retyped with different capitalization.
 *
 * Also catches duplicates *within* the same file (two rows sharing an
 * invoice number) — the first occurrence is kept, later ones are flagged,
 * same as if the second had already been on file.
 *
 * A row with no invoice number at all has no key to de-duplicate on and is
 * always imported — this only ever narrows re-imports of a row that
 * carries the same identifying number, never blocks a legitimately
 * numberless bill.
 */
export async function partitionBillImportRows<T extends BillImportRow>(
  rows: T[]
): Promise<{ toImport: T[]; duplicates: BillImportDuplicate[] }> {
  const numbers = [...new Set(rows.map((r) => r.invoiceNumber?.trim()).filter((n): n is string => !!n))];
  if (numbers.length === 0) return { toImport: rows, duplicates: [] };

  const [existingBills, existingInvoices] = await Promise.all([
    prisma.billEntry.findMany({
      where: { invoiceNumber: { in: numbers, mode: 'insensitive' } },
      select: { invoiceNumber: true },
    }),
    prisma.supplierInvoice.findMany({
      where: { number: { in: numbers, mode: 'insensitive' } },
      select: { number: true },
    }),
  ]);

  const alreadyOnFile = new Set(
    [...existingBills.map((b) => b.invoiceNumber), ...existingInvoices.map((i) => i.number)]
      .filter((n): n is string => !!n)
      .map((n) => n.toLowerCase())
  );

  const toImport: T[] = [];
  const duplicates: BillImportDuplicate[] = [];
  const seenInThisFile = new Set<string>();

  for (const row of rows) {
    const number = row.invoiceNumber?.trim();
    const key = number?.toLowerCase();
    if (key && alreadyOnFile.has(key)) {
      duplicates.push({ invoiceNumber: number!, vendor: row.vendor ?? null, reason: 'already_on_file' });
    } else if (key && seenInThisFile.has(key)) {
      duplicates.push({ invoiceNumber: number!, vendor: row.vendor ?? null, reason: 'duplicate_in_file' });
    } else {
      if (key) seenInThisFile.add(key);
      toImport.push(row);
    }
  }

  return { toImport, duplicates };
}
