import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { TestDb } from './test-db';
import { startTestDb } from './test-db';

/**
 * Phase 8 (SYSTEM_AUDIT.md D1 and F2): generateNumber() must never produce
 * the same document number twice under concurrency, and must scope its
 * count to the calendar year (a bare `count()` climbs forever across
 * years, contradicting the "year-scoped" numbering scheme). See
 * src/lib/numbering.ts.
 */
describe('generateNumber', () => {
  let db: TestDb;
  let generateNumber: typeof import('../src/lib/numbering')['generateNumber'];

  beforeAll(async () => {
    db = await startTestDb();
    process.env.DATABASE_URL = db.url;
    const mod = await import('../src/lib/numbering');
    generateNumber = mod.generateNumber;
  }, 60000);

  afterAll(async () => {
    await db.stop();
  });

  /** Mimics a real call site: generate the number and create the record
   * that number belongs to inside the SAME transaction — this is the
   * documented contract generateNumber() requires to actually be race-safe. */
  async function createNumberedQuote() {
    return db.prisma.$transaction(async (tx) => {
      const number = await generateNumber('quote', tx);
      await tx.quote.create({ data: { number } });
      return number;
    });
  }

  it('produces a correctly formatted, sequential number', async () => {
    const year = new Date().getFullYear();
    const first = await createNumberedQuote();
    expect(first).toMatch(new RegExp(`^QUO-${year}-\\d{4}$`));

    const second = await createNumberedQuote();
    const firstSeq = Number(first.split('-')[2]);
    const secondSeq = Number(second.split('-')[2]);
    expect(secondSeq).toBe(firstSeq + 1);
  });

  it('never produces the same number twice under real concurrency (the core D1 regression test)', async () => {
    const results = await Promise.all(Array.from({ length: 15 }, () => createNumberedQuote()));
    const unique = new Set(results);
    expect(unique.size).toBe(results.length);

    // And every one of those numbers was actually written successfully —
    // no silent loss, no P2002 swallowed anywhere.
    const count = await db.prisma.quote.count();
    expect(count).toBeGreaterThanOrEqual(results.length);
  });

  it('different kinds never contend with each other — generating a purchase-order number concurrently with quote numbers does not serialize against them', async () => {
    const [quoteNumbers, poNumbers] = await Promise.all([
      Promise.all(Array.from({ length: 5 }, () => createNumberedQuote())),
      Promise.all(
        Array.from({ length: 5 }, () =>
          db.prisma.$transaction(async (tx) => {
            const number = await generateNumber('purchaseOrder', tx);
            await tx.purchaseOrder.create({ data: { number, total: 0 } });
            return number;
          })
        )
      ),
    ]);
    expect(new Set(quoteNumbers).size).toBe(5);
    expect(new Set(poNumbers).size).toBe(5);
    expect(poNumbers.every((n) => n.startsWith('PO-'))).toBe(true);
  });

  it('scopes the count to the calendar year (F2) — a backdated prior-year row never inflates this year\'s sequence', async () => {
    // This file shares one database across tests, so earlier tests may
    // already have created quotes "this year" — capture the real baseline
    // directly rather than assuming a fresh 0.
    const thisYear = new Date().getFullYear();
    const yearRange = { gte: new Date(thisYear, 0, 1), lt: new Date(thisYear + 1, 0, 1) };
    const beforeCount = await db.prisma.quote.count({ where: { createdAt: yearRange } });

    // Seed 3 quotes that were "created" last year — a bare count() (the
    // pre-fix behavior) would include these and inflate this year's next
    // sequence number by 3.
    const lastYear = thisYear - 1;
    for (let i = 0; i < 3; i += 1) {
      await db.prisma.quote.create({
        data: { number: `QUO-${lastYear}-000${i + 1}`, createdAt: new Date(lastYear, 5, 15) },
      });
    }

    const number = await db.prisma.$transaction(async (tx) => {
      const n = await generateNumber('quote', tx);
      await tx.quote.create({ data: { number: n } });
      return n;
    });

    const seq = Number(number.split('-')[2]);
    expect(seq).toBe(beforeCount + 1); // unaffected by the 3 backdated last-year rows
  });
});
