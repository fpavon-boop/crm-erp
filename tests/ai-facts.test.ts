import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { TestDb } from './test-db';
import { startTestDb } from './test-db';

/**
 * Phase 14 (AI-Assisted Features, docs/AI_FEATURES.md): database-backed
 * tests for the deterministic FACTS builders in src/lib/ai/facts.ts —
 * the actual anti-hallucination guardrail. These facts are code-computed
 * and returned verbatim to the caller regardless of what the LLM does, so
 * the "no prior contact found" behavior (and the other "nothing to
 * report" cases) must be correct here, independent of any AI call.
 */
describe('AI facts builders', () => {
  let db: TestDb;
  let facts: typeof import('../src/lib/ai/facts');

  beforeAll(async () => {
    db = await startTestDb();
    process.env.DATABASE_URL = db.url;
    facts = await import('../src/lib/ai/facts');
  }, 60000);

  afterAll(async () => {
    await db.stop();
  });

  function id() {
    return Math.random().toString(36).slice(2);
  }

  async function makeCompany() {
    return db.prisma.company.create({ data: { name: `Co ${id()}`, type: 'CUSTOMER' } });
  }

  describe('buildCustomerSummaryFacts', () => {
    it('yields "No prior contact found" when the company has zero CommunicationLog rows', async () => {
      const company = await makeCompany();
      const { facts: result } = await facts.buildCustomerSummaryFacts(company.id, 'ADMIN');
      expect(result.some((f) => f.includes('No prior contact found'))).toBe(true);
    });

    it('reports the last contact instead, once a CommunicationLog row exists', async () => {
      const company = await makeCompany();
      await db.prisma.communicationLog.create({
        data: { type: 'EMAIL', direction: 'OUTBOUND', subject: 'Hello', status: 'SENT', companyId: company.id, recipient: 'x@example.com' },
      });
      const { facts: result } = await facts.buildCustomerSummaryFacts(company.id, 'ADMIN');
      expect(result.some((f) => f.includes('No prior contact found'))).toBe(false);
      expect(result.some((f) => f.includes('Last contact'))).toBe(true);
    });

    it('throws CompanyNotFoundError for a nonexistent company', async () => {
      await expect(facts.buildCustomerSummaryFacts('does-not-exist', 'ADMIN')).rejects.toBeInstanceOf(facts.CompanyNotFoundError);
    });
  });

  describe('buildFollowUpFacts', () => {
    it('reports nothing to follow up on when there are no stale quotes, overdue invoices, or pending tasks', async () => {
      const company = await makeCompany();
      const result = await facts.buildFollowUpFacts(company.id);
      expect(result.some((f) => f.includes('No inactive'))).toBe(true);
      expect(result.some((f) => f.includes('No overdue invoices'))).toBe(true);
      expect(result.some((f) => f.includes('No pending tasks'))).toBe(true);
    });

    it('flags a SENT quote older than the stale threshold as an inactive quote', async () => {
      const company = await makeCompany();
      const old = new Date(Date.now() - (facts.STALE_QUOTE_DAYS + 5) * 86_400_000);
      await db.prisma.quote.create({
        data: { number: `Q-${id()}`, companyId: company.id, status: 'SENT', total: 500, createdAt: old },
      });
      const result = await facts.buildFollowUpFacts(company.id);
      expect(result.some((f) => f.includes('Inactive quotes: 1'))).toBe(true);
    });

    it('does not flag a recently-sent quote as inactive', async () => {
      const company = await makeCompany();
      await db.prisma.quote.create({ data: { number: `Q-${id()}`, companyId: company.id, status: 'SENT', total: 500 } });
      const result = await facts.buildFollowUpFacts(company.id);
      expect(result.some((f) => f.includes('No inactive'))).toBe(true);
    });
  });

  describe('buildInventoryWarningFacts', () => {
    async function makeStockLevel(quantity: number, reorderPoint: number) {
      const warehouse = await db.prisma.warehouse.create({ data: { name: `WH-${id()}` } });
      const product = await db.prisma.product.create({ data: { sku: `SKU-${id()}`, name: 'Test brick', trackInventory: true, reorderPoint } });
      const variant = await db.prisma.productVariant.create({ data: { productId: product.id, sku: `${product.sku}-v`, name: 'Default' } });
      const level = await db.prisma.stockLevel.create({ data: { productVariantId: variant.id, warehouseId: warehouse.id, quantity } });
      return { product, variant, warehouse, level };
    }

    it('reports no active warning when quantity is above the reorder point', async () => {
      const { variant, warehouse } = await makeStockLevel(50, 10);
      const result = await facts.buildInventoryWarningFacts(variant.id, warehouse.id);
      expect(result.some((f) => f.includes('no active low-stock warning'))).toBe(true);
    });

    it('reports the shortfall and "no open sales orders" when quantity is at/below the reorder point with no open orders', async () => {
      const { variant, warehouse } = await makeStockLevel(2, 10);
      const result = await facts.buildInventoryWarningFacts(variant.id, warehouse.id);
      expect(result.some((f) => f.includes('Shortfall: 8'))).toBe(true);
      expect(result.some((f) => f.includes('No open (confirmed'))).toBe(true);
    });

    it('reports affected open confirmed sales orders when the low-stock product is on one', async () => {
      const { product, variant, warehouse } = await makeStockLevel(2, 10);
      const company = await makeCompany();
      await db.prisma.salesOrder.create({
        data: {
          number: `SO-${id()}`,
          status: 'CONFIRMED',
          companyId: company.id,
          items: { create: [{ productId: product.id, description: 'x', quantity: 3, unitPrice: 10 }] },
        },
      });
      const result = await facts.buildInventoryWarningFacts(variant.id, warehouse.id);
      expect(result.some((f) => f.includes('Open confirmed sales orders requiring this product: 1'))).toBe(true);
    });

    it('throws for a nonexistent stock level', async () => {
      const warehouse = await db.prisma.warehouse.create({ data: { name: `WH-${id()}` } });
      const product = await db.prisma.product.create({ data: { sku: `SKU-${id()}`, name: 'X' } });
      const variant = await db.prisma.productVariant.create({ data: { productId: product.id, sku: `${product.sku}-v`, name: 'Default' } });
      await expect(facts.buildInventoryWarningFacts(variant.id, warehouse.id)).rejects.toThrow();
    });
  });

  describe('buildProductAnalysisFacts', () => {
    it('reports no sales when a product has never been sold', async () => {
      const product = await db.prisma.product.create({ data: { sku: `SKU-${id()}`, name: 'Never sold', reorderPoint: 5 } });
      const result = await facts.buildProductAnalysisFacts(product.id);
      expect(result.some((f) => f.includes('No sales recorded for this product in the last 60 days'))).toBe(true);
    });

    it('throws for a nonexistent product', async () => {
      await expect(facts.buildProductAnalysisFacts('does-not-exist')).rejects.toThrow();
    });
  });

  describe('buildInvoiceAccountSummaryFacts', () => {
    it('reports no payments recorded when the account has none', async () => {
      const company = await makeCompany();
      const result = await facts.buildInvoiceAccountSummaryFacts(company.id);
      expect(result.some((f) => f.includes('No payments recorded for this account'))).toBe(true);
    });

    it('lists a recent payment when one exists', async () => {
      const company = await makeCompany();
      const invoice = await db.prisma.invoice.create({
        data: { number: `INV-${id()}`, type: 'INVOICE', status: 'PARTIAL', companyId: company.id, subtotal: 100, total: 100, amountPaid: 40 },
      });
      await db.prisma.payment.create({ data: { invoiceId: invoice.id, amount: 40, method: 'CASH' } });
      const result = await facts.buildInvoiceAccountSummaryFacts(company.id);
      expect(result.some((f) => f.includes('Recent payments'))).toBe(true);
      expect(result.some((f) => f.includes('No payments recorded'))).toBe(false);
    });
  });

  describe('buildEmailDraftFacts', () => {
    it('yields "No prior contact found" when there is no communication log for the company', async () => {
      const company = await makeCompany();
      const { facts: result, recipientEmail } = await facts.buildEmailDraftFacts({ companyId: company.id });
      expect(result.some((f) => f.includes('No prior contact found'))).toBe(true);
      expect(recipientEmail).toBeNull();
    });

    it('resolves the recipient email from a contact when one exists', async () => {
      const company = await makeCompany();
      const contact = await db.prisma.contact.create({
        data: { firstName: 'Jane', lastName: 'Doe', email: `jane-${id()}@example.com`, companyId: company.id },
      });
      const { recipientEmail } = await facts.buildEmailDraftFacts({ companyId: company.id, contactId: contact.id });
      expect(recipientEmail).toBe(contact.email);
    });

    it('includes a fact about a related quote when relatedType/relatedId point to one', async () => {
      const company = await makeCompany();
      const quote = await db.prisma.quote.create({ data: { number: `Q-${id()}`, companyId: company.id, status: 'SENT', total: 250 } });
      const { facts: result } = await facts.buildEmailDraftFacts({ companyId: company.id, relatedType: 'QUOTE', relatedId: quote.id });
      expect(result.some((f) => f.includes(`Related quote: #${quote.number}`))).toBe(true);
    });
  });
});
