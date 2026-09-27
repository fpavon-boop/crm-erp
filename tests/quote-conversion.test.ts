import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { TestDb } from './test-db';
import { startTestDb } from './test-db';

/**
 * docs/FINAL_SYSTEM_AUDIT.md #4 (HIGH): quotes/[id]/convert had no guard
 * against double-conversion — two concurrent requests could create two
 * SalesOrders from one Quote. Fixed via convertQuoteToSalesOrder(), which
 * mirrors createInvoiceForSalesOrder's advisory-lock + existing-record
 * pattern (see tests/sales-order-invoice-idempotency.test.ts).
 */
describe('Quote -> SalesOrder conversion', () => {
  let db: TestDb;
  let convertQuoteToSalesOrder: typeof import('../src/lib/sales-orders')['convertQuoteToSalesOrder'];
  let InvalidQuoteConversionError: typeof import('../src/lib/sales-orders')['InvalidQuoteConversionError'];
  let QuoteNotFoundError: typeof import('../src/lib/sales-orders')['QuoteNotFoundError'];

  beforeAll(async () => {
    db = await startTestDb();
    process.env.DATABASE_URL = db.url;
    const mod = await import('../src/lib/sales-orders');
    convertQuoteToSalesOrder = mod.convertQuoteToSalesOrder;
    InvalidQuoteConversionError = mod.InvalidQuoteConversionError;
    QuoteNotFoundError = mod.QuoteNotFoundError;
  }, 60000);

  afterAll(async () => {
    await db.stop();
  });

  async function seedQuote(status: 'DRAFT' | 'SENT' | 'ACCEPTED' | 'DECLINED' | 'EXPIRED' = 'ACCEPTED') {
    return db.prisma.quote.create({
      data: {
        number: `Q-${Math.random().toString(36).slice(2)}`,
        status,
        subtotal: 100,
        total: 100,
        items: { create: [{ description: 'Test item', quantity: 2, unitPrice: 50 }] },
      },
      include: { items: true },
    });
  }

  it('converts an ACCEPTED quote into a sales order', async () => {
    const quote = await seedQuote('ACCEPTED');
    const result = await convertQuoteToSalesOrder(quote);
    expect(result.created).toBe(true);
    expect(result.order.quoteId).toBe(quote.id);
    expect(Number(result.order.total)).toBe(100);
    expect(result.order.items).toHaveLength(1);
  });

  it('a second call returns the SAME order instead of creating another one', async () => {
    const quote = await seedQuote('ACCEPTED');
    const first = await convertQuoteToSalesOrder(quote);
    const second = await convertQuoteToSalesOrder(quote);

    expect(second.created).toBe(false);
    expect(second.order.id).toBe(first.order.id);

    const ordersForQuote = await db.prisma.salesOrder.findMany({ where: { quoteId: quote.id } });
    expect(ordersForQuote).toHaveLength(1);
  });

  it('THE FIX: two concurrent conversion requests for the same quote never create two orders', async () => {
    const quote = await seedQuote('ACCEPTED');

    const results = await Promise.all([convertQuoteToSalesOrder(quote), convertQuoteToSalesOrder(quote)]);

    const createdCount = results.filter((r) => r.created).length;
    expect(createdCount).toBe(1);
    expect(results[0].order.id).toBe(results[1].order.id);

    const ordersForQuote = await db.prisma.salesOrder.findMany({ where: { quoteId: quote.id } });
    expect(ordersForQuote).toHaveLength(1);
  });

  it('refuses to convert a quote that is not ACCEPTED', async () => {
    const quote = await seedQuote('SENT');
    await expect(convertQuoteToSalesOrder(quote)).rejects.toBeInstanceOf(InvalidQuoteConversionError);

    const ordersForQuote = await db.prisma.salesOrder.findMany({ where: { quoteId: quote.id } });
    expect(ordersForQuote).toHaveLength(0);
  });

  it('throws a clear error for a quote that no longer exists', async () => {
    const quote = await seedQuote('ACCEPTED');
    await db.prisma.salesOrderItem.deleteMany({ where: { salesOrder: { quoteId: quote.id } } }).catch(() => undefined);
    await db.prisma.quote.delete({ where: { id: quote.id } }).catch(async () => {
      // Items reference the quote too; delete them first if the FK blocks it.
      await db.prisma.quoteItem.deleteMany({ where: { quoteId: quote.id } });
      await db.prisma.quote.delete({ where: { id: quote.id } });
    });
    await expect(convertQuoteToSalesOrder(quote)).rejects.toBeInstanceOf(QuoteNotFoundError);
  });

  it('different quotes are unaffected by the per-quote lock and can convert in parallel', async () => {
    const [quoteA, quoteB] = await Promise.all([seedQuote('ACCEPTED'), seedQuote('ACCEPTED')]);
    const [resultA, resultB] = await Promise.all([convertQuoteToSalesOrder(quoteA), convertQuoteToSalesOrder(quoteB)]);
    expect(resultA.created).toBe(true);
    expect(resultB.created).toBe(true);
    expect(resultA.order.id).not.toBe(resultB.order.id);
  });
});
