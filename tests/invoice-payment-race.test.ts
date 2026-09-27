import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { TestDb } from './test-db';
import { startTestDb } from './test-db';

/**
 * docs/FINAL_SYSTEM_AUDIT.md #2 (HIGH): every payment-recording path
 * (manual entry, Stripe webhook, WooCommerce sync) read Invoice.amountPaid,
 * computed the new total in JS, and wrote the absolute value back — a
 * classic lost-update race. Fixed via applyInvoicePaymentDelta(), a single
 * atomic `UPDATE ... SET "amountPaid" = ... WHERE id = ...` that Postgres
 * serializes concurrent callers against automatically.
 */
describe('applyInvoicePaymentDelta (invoice payment race fix)', () => {
  let db: TestDb;
  let applyInvoicePaymentDelta: typeof import('../src/lib/accounts-receivable')['applyInvoicePaymentDelta'];

  beforeAll(async () => {
    db = await startTestDb();
    process.env.DATABASE_URL = db.url;
    const mod = await import('../src/lib/accounts-receivable');
    applyInvoicePaymentDelta = mod.applyInvoicePaymentDelta;
  }, 60000);

  afterAll(async () => {
    await db.stop();
  });

  async function seedInvoice(opts: { total: number; amountPaid?: number; status?: 'DRAFT' | 'SENT' | 'PARTIAL' | 'OVERDUE' | 'PAID' | 'CANCELLED' }) {
    return db.prisma.invoice.create({
      data: {
        number: `INV-${Math.random().toString(36).slice(2)}`,
        type: 'INVOICE',
        total: opts.total,
        amountPaid: opts.amountPaid ?? 0,
        status: opts.status ?? 'SENT',
      },
    });
  }

  it('applies a single payment and derives PARTIAL status', async () => {
    const invoice = await seedInvoice({ total: 500 });
    const result = await db.prisma.$transaction((tx) => applyInvoicePaymentDelta(tx, invoice.id, 200));
    expect(result.amountPaid).toBe(200);
    expect(result.status).toBe('PARTIAL');
  });

  it('a payment that reaches the full total derives PAID status', async () => {
    const invoice = await seedInvoice({ total: 500 });
    const result = await db.prisma.$transaction((tx) => applyInvoicePaymentDelta(tx, invoice.id, 500));
    expect(result.amountPaid).toBe(500);
    expect(result.status).toBe('PAID');
  });

  it('THE FIX: two concurrent payments for the same invoice both count — neither is lost', async () => {
    // This is the exact scenario from the audit: a Stripe webhook and a
    // manual payment landing at the same moment. Before the fix, both
    // transactions read amountPaid=0 and each wrote back their own
    // standalone total (200 or 300), so whichever committed last silently
    // discarded the other's $. The atomic increment must combine them: 500.
    const invoice = await seedInvoice({ total: 500 });

    await Promise.all([
      db.prisma.$transaction((tx) => applyInvoicePaymentDelta(tx, invoice.id, 200)),
      db.prisma.$transaction((tx) => applyInvoicePaymentDelta(tx, invoice.id, 300)),
    ]);

    const final = await db.prisma.invoice.findUniqueOrThrow({ where: { id: invoice.id } });
    expect(Number(final.amountPaid)).toBe(500);
    expect(final.status).toBe('PAID');
  });

  it('a refund (negative delta) reduces amountPaid and never goes below zero', async () => {
    const invoice = await seedInvoice({ total: 500, amountPaid: 300, status: 'PARTIAL' });
    const result = await db.prisma.$transaction((tx) => applyInvoicePaymentDelta(tx, invoice.id, -1000));
    expect(result.amountPaid).toBe(0);
  });

  it('treatDraftAsSent lets a fully-paid auto-created DRAFT invoice resolve straight to PAID', async () => {
    const invoice = await seedInvoice({ total: 500, status: 'DRAFT' });
    const result = await db.prisma.$transaction((tx) =>
      applyInvoicePaymentDelta(tx, invoice.id, 500, { treatDraftAsSent: true })
    );
    expect(result.status).toBe('PAID');
  });

  it('without treatDraftAsSent, a DRAFT invoice is left untouched by deriveInvoiceStatus (existing DRAFT/CANCELLED rule)', async () => {
    const invoice = await seedInvoice({ total: 500, status: 'DRAFT' });
    const result = await db.prisma.$transaction((tx) => applyInvoicePaymentDelta(tx, invoice.id, 500));
    expect(result.status).toBe('DRAFT');
  });
});
