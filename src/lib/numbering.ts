import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';

type Kind = 'quote' | 'salesOrder' | 'invoice' | 'estimate' | 'receipt' | 'purchaseOrder';
type Db = typeof prisma | Prisma.TransactionClient;

const PREFIXES: Record<Kind, string> = {
  quote: 'QUO',
  salesOrder: 'SO',
  invoice: 'INV',
  estimate: 'EST',
  receipt: 'REC',
  purchaseOrder: 'PO',
};

const COUNTERS: Record<Kind, (db: Db, range: { gte: Date; lt: Date }) => Promise<number>> = {
  quote: (db, range) => db.quote.count({ where: { createdAt: range } }),
  salesOrder: (db, range) => db.salesOrder.count({ where: { createdAt: range } }),
  invoice: (db, range) => db.invoice.count({ where: { type: 'INVOICE', createdAt: range } }),
  estimate: (db, range) => db.invoice.count({ where: { type: 'ESTIMATE', createdAt: range } }),
  receipt: (db, range) => db.invoice.count({ where: { type: 'RECEIPT', createdAt: range } }),
  purchaseOrder: (db, range) => db.purchaseOrder.count({ where: { createdAt: range } }),
};

/**
 * Generates a human-readable, year-scoped sequential document number
 * (e.g. `INV-2026-0143`).
 *
 * **Must be called from inside a `prisma.$transaction(async (tx) => ...)`
 * block, passing that `tx` as `db`, with the record the number is for
 * created in that *same* transaction, before it commits** (SYSTEM_AUDIT.md
 * D1). This is not optional: `pg_advisory_xact_lock` only holds for the
 * lifetime of the enclosing transaction, and the lock only actually
 * prevents a duplicate number if the row that makes this count go up is
 * itself committed before the next call is allowed to count — i.e. the
 * lock and the row-creation this count is protecting must be inside the
 * same transaction, not two separate ones. Every call site in this
 * codebase follows this (see `src/app/api/quotes/route.ts`,
 * `src/app/api/purchase-orders/route.ts`,
 * `src/app/api/invoices/route.ts`, `src/app/api/quotes/[id]/convert/route.ts`,
 * `createSalesOrderWithInventoryEffect` and `createInvoiceForSalesOrder` in
 * `src/lib/sales-orders.ts`).
 *
 * Previously this was a bare `count() + 1` with no locking at all: two
 * concurrent requests creating the same kind of document could compute the
 * identical number, and the loser would hit a raw, unhandled `P2002` from
 * the document's own `@unique` constraint on `number`. The lock is scoped
 * to `kind` + calendar year (`hashtext('number:<kind>:<year>')`), so
 * generating an invoice number never blocks generating a purchase-order
 * number, and a year rollover doesn't block anything either — only two
 * concurrent requests for the *same* kind in the *same* year ever
 * contend, and the second simply waits its turn rather than racing.
 *
 * Also fixes a second, previously-undetected bug in the same function
 * (SYSTEM_AUDIT.md F2): the count query had no date filter at all, so the
 * sequence number climbed forever across years instead of resetting each
 * January — contradicting this function's own "year-scoped" description.
 * It's now scoped to `[Jan 1 00:00:00, Jan 1 00:00:00 next year)` of the
 * *server's local* year, matching how the prefix year is computed.
 */
export async function generateNumber(kind: Kind, db: Db): Promise<string> {
  const now = new Date();
  const year = now.getFullYear();
  const range = { gte: new Date(year, 0, 1), lt: new Date(year + 1, 0, 1) };

  await db.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`number:${kind}:${year}`}))`;

  const count = await COUNTERS[kind](db, range);
  const sequence = String(count + 1).padStart(4, '0');
  return `${PREFIXES[kind]}-${year}-${sequence}`;
}
