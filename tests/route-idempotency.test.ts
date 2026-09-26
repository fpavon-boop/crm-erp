import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import type { TestDb } from './test-db';
import { startTestDb } from './test-db';

vi.mock('next-auth', async () => {
  const actual = await vi.importActual<typeof import('next-auth')>('next-auth');
  return { ...actual, getServerSession: vi.fn() };
});

/**
 * Phase 13 (Automation System Hardening, docs/AUTOMATION_SYSTEM.md),
 * requirement 2 (Idempotency & Deduplication Engine): every manual,
 * human-triggered write path that can be double-submitted (a network
 * retry, a double-click before a button disables) — recording a payment,
 * adjusting inventory, creating a Company/Contact — must treat a repeat
 * of the same idempotencyKey as a safe no-op instead of creating a second
 * row. These call the actual route handlers (not the underlying library
 * functions) so the wiring at the HTTP boundary is what's under test,
 * with next-auth's session lookup stubbed to a fixed ADMIN user (the
 * seam every route already exposes via requireApiModule/getServerSession
 * — no production code changed to make this testable).
 */
describe('Route-level idempotency (manual double-submit protection)', () => {
  let db: TestDb;
  let getServerSession: ReturnType<typeof vi.fn>;

  beforeAll(async () => {
    db = await startTestDb();
    process.env.DATABASE_URL = db.url;

    const nextAuth = await import('next-auth');
    getServerSession = nextAuth.getServerSession as unknown as ReturnType<typeof vi.fn>;
  }, 60000);

  afterAll(async () => {
    await db.stop();
  });

  function id() {
    return Math.random().toString(36).slice(2);
  }

  async function makeAdminSession() {
    const user = await db.prisma.user.create({
      data: { name: 'Admin', email: `admin-${id()}@example.com`, passwordHash: 'x', role: 'ADMIN' },
    });
    getServerSession.mockResolvedValue({ user: { id: user.id, name: user.name, email: user.email, role: 'ADMIN' } });
    return user;
  }

  async function post(url: string, body: unknown) {
    const { NextRequest } = await import('next/server');
    return new NextRequest(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  }

  it('POST /api/invoices/[id]/payments: the same idempotencyKey submitted twice records exactly one Payment', async () => {
    await makeAdminSession();
    const { POST } = await import('../src/app/api/invoices/[id]/payments/route');

    const company = await db.prisma.company.create({ data: { name: `Co ${id()}`, type: 'CUSTOMER' } });
    const invoice = await db.prisma.invoice.create({
      data: { number: `INV-${id()}`, type: 'INVOICE', status: 'SENT', companyId: company.id, subtotal: 100, total: 100 },
    });

    const key = `pay-${id()}`;
    const payload = { amount: 50, method: 'CASH', idempotencyKey: key };
    const url = `http://localhost/api/invoices/${invoice.id}/payments`;

    const first = await POST(await post(url, payload), { params: { id: invoice.id } });
    const second = await POST(await post(url, payload), { params: { id: invoice.id } });

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    const secondJson = await second.json();
    expect(secondJson.duplicate).toBe(true);

    const payments = await db.prisma.payment.count({ where: { invoiceId: invoice.id } });
    expect(payments).toBe(1);
    const updated = await db.prisma.invoice.findUniqueOrThrow({ where: { id: invoice.id } });
    expect(Number(updated.amountPaid)).toBe(50); // not 100 — the second submit did not double-apply the payment
  });

  it('POST /api/supplier-invoices/[id]/payments: the same idempotencyKey submitted twice records exactly one SupplierPayment', async () => {
    await makeAdminSession();
    const { POST } = await import('../src/app/api/supplier-invoices/[id]/payments/route');

    const bill = await db.prisma.supplierInvoice.create({ data: { number: `BILL-${id()}`, amount: 100 } });
    const key = `spay-${id()}`;
    const payload = { amount: 40, method: 'CHECK', idempotencyKey: key };
    const url = `http://localhost/api/supplier-invoices/${bill.id}/payments`;

    const first = await POST(await post(url, payload), { params: { id: bill.id } });
    const second = await POST(await post(url, payload), { params: { id: bill.id } });

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    const secondJson = await second.json();
    expect(secondJson.duplicate).toBe(true);

    const payments = await db.prisma.supplierPayment.count({ where: { supplierInvoiceId: bill.id } });
    expect(payments).toBe(1);
    const updated = await db.prisma.supplierInvoice.findUniqueOrThrow({ where: { id: bill.id } });
    expect(Number(updated.amountPaid)).toBe(40);
  });

  it('POST /api/inventory/adjust: the same idempotencyKey submitted twice posts exactly one StockMovement', async () => {
    await makeAdminSession();
    const { POST } = await import('../src/app/api/inventory/adjust/route');

    const warehouse = await db.prisma.warehouse.create({ data: { name: `WH-${id()}`, isDefault: true } });
    const product = await db.prisma.product.create({ data: { sku: `SKU-${id()}`, name: 'Test brick', trackInventory: true } });
    const variant = await db.prisma.productVariant.create({ data: { productId: product.id, sku: `${product.sku}-v`, name: 'Default' } });

    const key = `adj-${id()}`;
    const payload = { productVariantId: variant.id, warehouseId: warehouse.id, type: 'IN', quantity: 10, idempotencyKey: key };
    const url = 'http://localhost/api/inventory/adjust';

    const first = await POST(await post(url, payload));
    const second = await POST(await post(url, payload));

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    const secondJson = await second.json();
    expect(secondJson.duplicate).toBe(true);

    const movements = await db.prisma.stockMovement.count({ where: { productVariantId: variant.id, warehouseId: warehouse.id } });
    expect(movements).toBe(1);
    const level = await db.prisma.stockLevel.findUnique({
      where: { productVariantId_warehouseId: { productVariantId: variant.id, warehouseId: warehouse.id } },
    });
    expect(level?.quantity).toBe(10); // not 20 — the second submit did not double-apply the adjustment
  });

  it('POST /api/companies: the same idempotencyKey submitted twice creates exactly one Company', async () => {
    await makeAdminSession();
    const { POST } = await import('../src/app/api/companies/route');

    const key = `co-${id()}`;
    const name = `Idempotent Co ${id()}`;
    const payload = { name, type: 'CUSTOMER', idempotencyKey: key };
    const url = 'http://localhost/api/companies';

    const first = await POST(await post(url, payload));
    const second = await POST(await post(url, payload));

    expect(first.status).toBe(201);
    const firstJson = await first.json();
    const secondJson = await second.json();
    expect(secondJson.duplicate).toBe(true);
    expect(secondJson.company.id).toBe(firstJson.company.id);

    const count = await db.prisma.company.count({ where: { name } });
    expect(count).toBe(1);
  });

  it('POST /api/contacts: the same idempotencyKey submitted twice creates exactly one Contact', async () => {
    await makeAdminSession();
    const { POST } = await import('../src/app/api/contacts/route');

    const key = `ct-${id()}`;
    const email = `idem-contact-${id()}@example.com`;
    const payload = { firstName: 'Idem', lastName: 'Potent', email, idempotencyKey: key };
    const url = 'http://localhost/api/contacts';

    const first = await POST(await post(url, payload));
    const second = await POST(await post(url, payload));

    expect(first.status).toBe(201);
    const firstJson = await first.json();
    const secondJson = await second.json();
    expect(secondJson.duplicate).toBe(true);
    expect(secondJson.contact.id).toBe(firstJson.contact.id);

    const count = await db.prisma.contact.count({ where: { email } });
    expect(count).toBe(1);
  });

  it('a different idempotencyKey is a genuinely new request: two Company creations with different keys both succeed', async () => {
    await makeAdminSession();
    const { POST } = await import('../src/app/api/companies/route');

    const nameA = `Distinct Co A ${id()}`;
    const nameB = `Distinct Co B ${id()}`;
    const url = 'http://localhost/api/companies';
    await POST(await post(url, { name: nameA, type: 'CUSTOMER', idempotencyKey: `co-${id()}` }));
    await POST(await post(url, { name: nameB, type: 'CUSTOMER', idempotencyKey: `co-${id()}` }));

    expect(await db.prisma.company.count({ where: { name: nameA } })).toBe(1);
    expect(await db.prisma.company.count({ where: { name: nameB } })).toBe(1);
  });
});
