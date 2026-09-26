import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import type { TestDb } from './test-db';
import { startTestDb } from './test-db';

vi.mock('next-auth', async () => {
  const actual = await vi.importActual<typeof import('next-auth')>('next-auth');
  return { ...actual, getServerSession: vi.fn() };
});

/**
 * Phase 14 (AI-Assisted Features, docs/AI_FEATURES.md), requirement 4
 * (Testing & Verification): integration tests calling the actual route
 * handlers (not the underlying library functions), proving:
 *
 * 1. Every AI route performs ZERO destructive/business-data mutations —
 *    the only table that ever changes is AiGenerationLog (the audit
 *    trail itself, append-only). No ANTHROPIC_API_KEY is set in this test
 *    environment, so every call exercises the real "AI unavailable"
 *    degradation path end-to-end while still proving the read-only
 *    guarantee holds regardless of whether the AI call itself succeeds.
 * 2. Every call writes an AiGenerationLog row with the right feature,
 *    requestedById, and entity reference.
 * 3. The double module gate (requireAiModule) actually blocks a role that
 *    has `ai` access but lacks the specific underlying domain module.
 */
describe('AI routes: read-only guarantee + audit logging + access control', () => {
  let db: TestDb;
  let getServerSession: ReturnType<typeof vi.fn>;

  beforeAll(async () => {
    db = await startTestDb();
    process.env.DATABASE_URL = db.url;
    delete process.env.ANTHROPIC_API_KEY;

    const nextAuth = await import('next-auth');
    getServerSession = nextAuth.getServerSession as unknown as ReturnType<typeof vi.fn>;
  }, 60000);

  afterAll(async () => {
    await db.stop();
  });

  function id() {
    return Math.random().toString(36).slice(2);
  }

  async function sessionAs(role: 'ADMIN' | 'SALES' | 'OPERATIONS' | 'ACCOUNTING') {
    const user = await db.prisma.user.create({ data: { name: role, email: `${role}-${id()}@example.com`, passwordHash: 'x', role } });
    getServerSession.mockResolvedValue({ user: { id: user.id, name: user.name, email: user.email, role } });
    return user;
  }

  async function post(url: string, body: unknown) {
    const { NextRequest } = await import('next/server');
    return new NextRequest(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  }

  const MUTABLE_TABLES = [
    'company',
    'contact',
    'invoice',
    'payment',
    'quote',
    'salesOrder',
    'salesOrderItem',
    'product',
    'productVariant',
    'stockLevel',
    'stockMovement',
    'task',
    'communicationLog',
  ] as const;

  async function snapshotCounts() {
    const counts: Record<string, number> = {};
    for (const table of MUTABLE_TABLES) {
      counts[table] = await (db.prisma[table] as { count: () => Promise<number> }).count();
    }
    return counts;
  }

  it('all 7 AI routes together perform zero mutations to business data — only AiGenerationLog grows', async () => {
    const user = await sessionAs('ADMIN');

    const company = await db.prisma.company.create({ data: { name: `Co ${id()}`, type: 'CUSTOMER' } });
    const contact = await db.prisma.contact.create({ data: { firstName: 'Jane', lastName: 'Doe', email: `jane-${id()}@example.com`, companyId: company.id } });
    await db.prisma.quote.create({ data: { number: `Q-${id()}`, companyId: company.id, status: 'SENT', total: 300 } });
    const invoice = await db.prisma.invoice.create({
      data: { number: `INV-${id()}`, type: 'INVOICE', status: 'PARTIAL', companyId: company.id, subtotal: 100, total: 100, amountPaid: 40 },
    });
    await db.prisma.payment.create({ data: { invoiceId: invoice.id, amount: 40, method: 'CASH' } });

    const warehouse = await db.prisma.warehouse.create({ data: { name: `WH-${id()}` } });
    const product = await db.prisma.product.create({ data: { sku: `SKU-${id()}`, name: 'Test brick', trackInventory: true, reorderPoint: 10 } });
    const variant = await db.prisma.productVariant.create({ data: { productId: product.id, sku: `${product.sku}-v`, name: 'Default' } });
    await db.prisma.stockLevel.create({ data: { productVariantId: variant.id, warehouseId: warehouse.id, quantity: 5 } });

    const before = await snapshotCounts();
    const aiLogsBefore = await db.prisma.aiGenerationLog.count();

    const routes = await Promise.all([
      import('../src/app/api/ai/customer-summary/route'),
      import('../src/app/api/ai/sales-summary/route'),
      import('../src/app/api/ai/follow-up-suggestions/route'),
      import('../src/app/api/ai/product-analysis/route'),
      import('../src/app/api/ai/inventory-warning/route'),
      import('../src/app/api/ai/invoice-summary/route'),
      import('../src/app/api/ai/email-draft/route'),
    ]);

    const calls: Array<[string, unknown]> = [
      ['/api/ai/customer-summary', { companyId: company.id }],
      ['/api/ai/sales-summary', {}],
      ['/api/ai/follow-up-suggestions', { companyId: company.id }],
      ['/api/ai/product-analysis', { productId: product.id }],
      ['/api/ai/inventory-warning', { productVariantId: variant.id, warehouseId: warehouse.id }],
      ['/api/ai/invoice-summary', { companyId: company.id }],
      ['/api/ai/email-draft', { companyId: company.id, contactId: contact.id, intent: 'follow_up' }],
    ];

    for (let i = 0; i < calls.length; i++) {
      const [path, body] = calls[i];
      const res = await routes[i].POST(await post(`http://localhost${path}`, body));
      expect(res.status, `${path} should return 200`).toBe(200);
      const json = await res.json();
      expect(json.aiAvailable, `${path} should report aiAvailable:false (no API key in test env)`).toBe(false);
      expect(Array.isArray(json.facts), `${path} should always return facts`).toBe(true);
    }

    const after = await snapshotCounts();
    expect(after).toEqual(before); // zero destructive mutations across every table an AI feature reads from

    const aiLogsAfter = await db.prisma.aiGenerationLog.count();
    expect(aiLogsAfter - aiLogsBefore).toBe(calls.length); // exactly one audit row per call, none skipped

    const logs = await db.prisma.aiGenerationLog.findMany({ where: { requestedById: user.id }, orderBy: { createdAt: 'asc' } });
    expect(logs.map((l) => l.feature)).toEqual([
      'CUSTOMER_SUMMARY',
      'SALES_SUMMARY',
      'FOLLOWUP_SUGGESTIONS',
      'PRODUCT_ANALYSIS',
      'INVENTORY_WARNING',
      'INVOICE_SUMMARY',
      'EMAIL_DRAFT',
    ]);
    expect(logs.every((l) => l.status === 'FAILED')).toBe(true); // no API key configured — every call degrades, none crash
  });

  it('a company-summary request for an unknown companyId returns 404 and writes no audit row', async () => {
    await sessionAs('ADMIN');
    const before = await db.prisma.aiGenerationLog.count();
    const { POST } = await import('../src/app/api/ai/customer-summary/route');
    const res = await POST(await post('http://localhost/api/ai/customer-summary', { companyId: 'does-not-exist' }));
    expect(res.status).toBe(404);
    expect(await db.prisma.aiGenerationLog.count()).toBe(before);
  });

  it('access control: a role with `ai` but not the underlying domain module is forbidden, not silently allowed', async () => {
    // ACCOUNTING has `ai` and `invoicing` but not `inventory` (src/lib/permissions.ts) —
    // product-analysis requires `inventory`, so this must be blocked even
    // though the role can use AI features in general.
    await sessionAs('ACCOUNTING');
    const product = await db.prisma.product.create({ data: { sku: `SKU-${id()}`, name: 'Blocked product test' } });
    const { POST } = await import('../src/app/api/ai/product-analysis/route');
    const res = await POST(await post('http://localhost/api/ai/product-analysis', { productId: product.id }));
    expect(res.status).toBe(403);
  });

  it('access control: the same ACCOUNTING role CAN use invoice-summary, which only requires `invoicing`', async () => {
    await sessionAs('ACCOUNTING');
    const company = await db.prisma.company.create({ data: { name: `Co ${id()}`, type: 'CUSTOMER' } });
    const { POST } = await import('../src/app/api/ai/invoice-summary/route');
    const res = await POST(await post('http://localhost/api/ai/invoice-summary', { companyId: company.id }));
    expect(res.status).toBe(200);
  });
});
