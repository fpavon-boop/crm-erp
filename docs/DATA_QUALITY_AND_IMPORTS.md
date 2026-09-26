# Data Quality & Import Hardening

**Date:** 2026-09-25 (Phase 12)
**Status:** Implemented and tested. This document is the explicit behavior —
code should match this, not the other way around.

## What this is

Two data-quality gaps from `docs/SYSTEM_AUDIT.md`, both still open through
Phase 11:

- **G** — the manual "New Company"/"New Contact" forms had no duplicate
  detection at all, even though the WooCommerce sync path
  (`resolveOrderCustomer()`) has always matched guest/customer records this
  same way before creating one.
- **E5** — bulk CSV bill import (`POST /api/bills`) inserted every row
  unconditionally; re-importing the same file (or an overlapping one)
  created a second review-queue entry for every already-known invoice.

Both fixes live in one new module, `src/lib/duplicate-detection.ts`, since
they're the same underlying concern (don't silently create a second record
for something that already exists) applied to two different flows.

## G — Manual Company/Contact duplicate detection

`findPossibleDuplicateCompanies(name)` / `findPossibleDuplicateContacts({email, firstName, lastName})`
reuse the exact matching WooCommerce sync already does:

- **Company**: case-insensitive exact name match, regardless of `type` — a
  `CUSTOMER` and a `SUPPLIER` row sharing a name are still flagged, since
  the same real-world company appearing twice under different type flags
  is exactly the kind of duplicate worth catching.
- **Contact**: case-insensitive exact email match (the strong signal) when
  an email is given; falls back to a case-insensitive exact first+last
  name match when it isn't (a real, common case for a phone-only contact
  that would otherwise never be checked at all).

### This is a warning, not a hard block

`POST /api/companies` and `POST /api/contacts` return the match(es) found
(HTTP 409, `{ duplicate: true, matches: [...] }`) **instead of** creating,
unless the request explicitly includes `confirmDuplicate: true`. The
"New Company"/"New Contact" forms (`CompanyForm.tsx`, `ContactForm.tsx`)
show the matched existing record(s) as a clickable link and a "Create
anyway" button that resubmits with that flag set. Nothing is silently
blocked and nothing is silently duplicated — the human sees the collision
and decides, the same "human in the loop" principle Phase 10's
communication-sending already established for this app.

**Scope**: this phase only covers *creation* (`POST`) — editing an
existing Company/Contact to a name/email that collides with another record
is not checked. `findPossibleDuplicateCompanies`/`findPossibleDuplicateContacts`
both accept an optional `excludeId` for exactly that future use, but no
edit route calls them yet.

## E5 — Bulk CSV bill import duplicate check

`partitionBillImportRows(rows)` splits an incoming batch into `toImport`
and `duplicates` before `POST /api/bills` calls `billEntry.createMany()`.
A row's `invoiceNumber` (case-insensitive) is checked against:

1. Every existing `BillEntry.invoiceNumber`, **regardless of review
   status** — a bill already waiting for review, already approved, or
   already rejected is still "already imported."
2. Every existing `SupplierInvoice.number` — an already-approved,
   already-posted bill (`docs/SYSTEM_HARDENING.md` D5's
   `approveBillEntryAsBill()` is what creates these).
3. **Every other row already seen earlier in the same file** — two rows
   sharing an invoice number within one CSV are caught too; the first is
   imported, later ones are flagged `duplicate_in_file`.

A row with no invoice number at all has nothing to key a duplicate check
on and is always imported — this narrows re-imports of a row carrying the
same identifying number, and never blocks a legitimately numberless bill.

The response (`{ imported, duplicates: [{invoiceNumber, vendor, reason}] }`)
is fully informative rather than silently dropping rows: the "Import a
list (CSV)" panel on `/finance/bills` reports exactly how many rows were
imported, how many were invalid (existing behavior, unchanged), and how
many were skipped as duplicates and why.

## Testing

`tests/duplicate-detection.test.ts` — database-backed:

- Company matching: exact/case-insensitive hit, matches across different
  `type`s, no false positive on a new name, `excludeId` behavior, blank
  name never matches.
- Contact matching: email match takes priority over name, name-fallback
  when no email is given, no false positive, `excludeId` behavior.
- Import partitioning: a numberless row always passes through; a row
  matching an existing `BillEntry` is flagged `already_on_file`; a row
  matching an existing `SupplierInvoice` is flagged `already_on_file`; two
  rows sharing a number within one file — the first imports, the second is
  flagged `duplicate_in_file`; a mixed batch partitions correctly; an empty
  batch is a no-op.

## Security / data-safety notes

Both checks are additive, read-before-write logic — no existing row is
ever modified, and no existing data was touched implementing this phase.
A duplicate warning never prevents the human from proceeding if they
decide the "duplicate" is intentional (e.g. two genuinely different
companies that happen to share a name).
