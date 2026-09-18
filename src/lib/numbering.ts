import { prisma } from '@/lib/prisma';

type Kind = 'quote' | 'salesOrder' | 'invoice' | 'estimate' | 'receipt' | 'purchaseOrder';

const PREFIXES: Record<Kind, string> = {
  quote: 'QUO',
  salesOrder: 'SO',
  invoice: 'INV',
  estimate: 'EST',
  receipt: 'REC',
  purchaseOrder: 'PO',
};

const COUNTERS: Record<Kind, () => Promise<number>> = {
  quote: () => prisma.quote.count(),
  salesOrder: () => prisma.salesOrder.count(),
  invoice: () => prisma.invoice.count({ where: { type: 'INVOICE' } }),
  estimate: () => prisma.invoice.count({ where: { type: 'ESTIMATE' } }),
  receipt: () => prisma.invoice.count({ where: { type: 'RECEIPT' } }),
  purchaseOrder: () => prisma.purchaseOrder.count(),
};

/** Generates a human-readable, year-scoped sequential document number. */
export async function generateNumber(kind: Kind): Promise<string> {
  const year = new Date().getFullYear();
  const count = await COUNTERS[kind]();
  const sequence = String(count + 1).padStart(4, '0');
  return `${PREFIXES[kind]}-${year}-${sequence}`;
}
