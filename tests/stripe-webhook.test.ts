import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import Stripe from 'stripe';
import type { TestDb } from './test-db';
import { startTestDb } from './test-db';

/**
 * Phase 4 (Stripe integration). Exercises the real webhook signature
 * verification (via Stripe's own `generateTestHeaderString` test helper —
 * genuine HMAC-SHA256, not mocked) and the real reconciliation logic
 * against a real migrated Postgres instance. See
 * docs/STRIPE_INTEGRATION.md.
 */
describe('Stripe webhook processing', () => {
  let db: TestDb;
  let processStripeWebhook: typeof import('../src/lib/stripe/webhook')['processStripeWebhook'];
  let InvalidStripeSignatureError: typeof import('../src/lib/stripe/webhook')['InvalidStripeSignatureError'];

  const WEBHOOK_SECRET = 'whsec_test_secret_for_this_file_only';

  beforeAll(async () => {
    db = await startTestDb();
    process.env.DATABASE_URL = db.url;
    process.env.STRIPE_SECRET_KEY = 'sk_test_dummy';
    process.env.STRIPE_WEBHOOK_SECRET = WEBHOOK_SECRET;

    const mod = await import('../src/lib/stripe/webhook');
    processStripeWebhook = mod.processStripeWebhook;
    InvalidStripeSignatureError = mod.InvalidStripeSignatureError;
  }, 60000);

  afterAll(async () => {
    await db.stop();
  });

  function sign(payload: string, secret = WEBHOOK_SECRET) {
    return Stripe.webhooks.generateTestHeaderString({ payload, secret });
  }

  function randomId(prefix: string) {
    return `${prefix}_${Math.random().toString(36).slice(2)}`;
  }

  async function seedInvoice(total: number, amountPaid = 0) {
    const company = await db.prisma.company.create({ data: { name: `Co ${Math.random()}`, type: 'CUSTOMER' } });
    const invoice = await db.prisma.invoice.create({
      data: { number: `INV-${Math.random().toString(36).slice(2)}`, companyId: company.id, status: 'SENT', total, amountPaid },
    });
    return invoice;
  }

  function paymentIntentEvent(type: 'payment_intent.succeeded' | 'payment_intent.payment_failed', object: Record<string, unknown>) {
    return { id: randomId('evt'), type, data: { object: { object: 'payment_intent', metadata: {}, ...object } } };
  }

  function chargeRefundedEvent(object: Record<string, unknown>) {
    return { id: randomId('evt'), type: 'charge.refunded', data: { object: { object: 'charge', ...object } } };
  }

  beforeEach(() => {
    // Nothing per-test to reset — every seed helper creates fresh rows.
  });

  it('successful payment: creates a Payment, marks the invoice PAID, records the Stripe transaction id/method/date', async () => {
    const invoice = await seedInvoice(100);
    const piId = randomId('pi');
    const chargeId = randomId('ch');
    const event = paymentIntentEvent('payment_intent.succeeded', {
      id: piId,
      amount: 10000,
      amount_received: 10000,
      latest_charge: chargeId,
      metadata: { invoiceId: invoice.id },
    });
    const payload = JSON.stringify(event);

    const result = await processStripeWebhook(payload, sign(payload));
    expect(result).toEqual({ received: true, duplicate: false, eventType: 'payment_intent.succeeded' });

    const payment = await db.prisma.payment.findUniqueOrThrow({ where: { stripePaymentIntentId: piId } });
    expect(Number(payment.amount)).toBe(100);
    expect(payment.method).toBe('stripe');
    expect(payment.reference).toBe(piId);
    expect(payment.stripeChargeId).toBe(chargeId);
    expect(payment.paidAt).toBeInstanceOf(Date);

    const updated = await db.prisma.invoice.findUniqueOrThrow({ where: { id: invoice.id } });
    expect(updated.status).toBe('PAID');
    expect(Number(updated.amountPaid)).toBe(100);
  });

  it('partial payment: amount less than the invoice total leaves it PARTIAL, not PAID', async () => {
    const invoice = await seedInvoice(200);
    const event = paymentIntentEvent('payment_intent.succeeded', {
      id: randomId('pi'),
      amount: 8000,
      amount_received: 8000,
      metadata: { invoiceId: invoice.id },
    });
    const payload = JSON.stringify(event);

    await processStripeWebhook(payload, sign(payload));

    const updated = await db.prisma.invoice.findUniqueOrThrow({ where: { id: invoice.id } });
    expect(updated.status).toBe('PARTIAL');
    expect(Number(updated.amountPaid)).toBe(80);
  });

  it('failed payment: no Payment is created and the invoice is untouched, but the failure is logged', async () => {
    const invoice = await seedInvoice(100);
    const piId = randomId('pi');
    const event = paymentIntentEvent('payment_intent.payment_failed', {
      id: piId,
      metadata: { invoiceId: invoice.id },
      last_payment_error: { message: 'Your card was declined.' },
    });
    const payload = JSON.stringify(event);

    const result = await processStripeWebhook(payload, sign(payload));
    expect(result.duplicate).toBe(false);

    const payment = await db.prisma.payment.findUnique({ where: { stripePaymentIntentId: piId } });
    expect(payment).toBeNull();

    const updated = await db.prisma.invoice.findUniqueOrThrow({ where: { id: invoice.id } });
    expect(updated.status).toBe('SENT');
    expect(Number(updated.amountPaid)).toBe(0);

    const logs = await db.prisma.automationLog.findMany({ where: { entityType: 'STRIPE_WEBHOOK', entityId: piId, success: false } });
    expect(logs.some((l) => l.message?.includes('declined'))).toBe(true);
  });

  it('duplicate webhook delivery (same event id twice): the second delivery is a no-op, not a second Payment', async () => {
    const invoice = await seedInvoice(100);
    const event = paymentIntentEvent('payment_intent.succeeded', {
      id: randomId('pi'),
      amount: 10000,
      amount_received: 10000,
      metadata: { invoiceId: invoice.id },
    });
    const payload = JSON.stringify(event);
    const signature = sign(payload);

    const first = await processStripeWebhook(payload, signature);
    const second = await processStripeWebhook(payload, signature);

    expect(first.duplicate).toBe(false);
    expect(second.duplicate).toBe(true);

    const payments = await db.prisma.payment.findMany({ where: { invoiceId: invoice.id } });
    expect(payments).toHaveLength(1);
    const updated = await db.prisma.invoice.findUniqueOrThrow({ where: { id: invoice.id } });
    expect(Number(updated.amountPaid)).toBe(100); // not 200
  });

  it('full refund: reverses the payment amount and returns the invoice to SENT', async () => {
    const invoice = await seedInvoice(100);
    const piId = randomId('pi');
    const chargeId = randomId('ch');
    const succeeded = paymentIntentEvent('payment_intent.succeeded', {
      id: piId,
      amount: 10000,
      amount_received: 10000,
      latest_charge: chargeId,
      metadata: { invoiceId: invoice.id },
    });
    await processStripeWebhook(JSON.stringify(succeeded), sign(JSON.stringify(succeeded)));

    const refund = chargeRefundedEvent({ id: chargeId, payment_intent: piId, amount_refunded: 10000 });
    const refundPayload = JSON.stringify(refund);
    const result = await processStripeWebhook(refundPayload, sign(refundPayload));
    expect(result.eventType).toBe('charge.refunded');

    const payment = await db.prisma.payment.findUniqueOrThrow({ where: { stripePaymentIntentId: piId } });
    expect(Number(payment.refundedAmount)).toBe(100);

    const updated = await db.prisma.invoice.findUniqueOrThrow({ where: { id: invoice.id } });
    expect(Number(updated.amountPaid)).toBe(0);
    expect(updated.status).toBe('SENT');
  });

  it('partial refund: reverses only part of the payment and leaves the invoice PARTIAL', async () => {
    const invoice = await seedInvoice(100);
    const piId = randomId('pi');
    const chargeId = randomId('ch');
    const succeeded = paymentIntentEvent('payment_intent.succeeded', {
      id: piId,
      amount: 10000,
      amount_received: 10000,
      latest_charge: chargeId,
      metadata: { invoiceId: invoice.id },
    });
    await processStripeWebhook(JSON.stringify(succeeded), sign(JSON.stringify(succeeded)));

    const refund = chargeRefundedEvent({ id: chargeId, payment_intent: piId, amount_refunded: 3000 }); // $30 of $100
    const refundPayload = JSON.stringify(refund);
    await processStripeWebhook(refundPayload, sign(refundPayload));

    const payment = await db.prisma.payment.findUniqueOrThrow({ where: { stripePaymentIntentId: piId } });
    expect(Number(payment.refundedAmount)).toBe(30);

    const updated = await db.prisma.invoice.findUniqueOrThrow({ where: { id: invoice.id } });
    expect(Number(updated.amountPaid)).toBe(70);
    expect(updated.status).toBe('PARTIAL');
  });

  it('invalid webhook signature: rejected before anything is processed or written', async () => {
    const invoice = await seedInvoice(100);
    const event = paymentIntentEvent('payment_intent.succeeded', {
      id: randomId('pi'),
      amount: 10000,
      amount_received: 10000,
      metadata: { invoiceId: invoice.id },
    });
    const payload = JSON.stringify(event);
    const eventsBefore = await db.prisma.stripeWebhookEvent.count();

    await expect(processStripeWebhook(payload, sign(payload, 'whsec_totally_wrong_secret'))).rejects.toBeInstanceOf(
      InvalidStripeSignatureError
    );
    await expect(processStripeWebhook(payload, null)).rejects.toBeInstanceOf(InvalidStripeSignatureError);
    await expect(processStripeWebhook(payload, 'not-a-real-signature')).rejects.toBeInstanceOf(InvalidStripeSignatureError);

    // None of the three rejected attempts recorded an event or touched the
    // invoice — compared against the count before, since this test shares
    // one database with the rest of the file (other tests' events already
    // legitimately exist in this table).
    const eventsAfter = await db.prisma.stripeWebhookEvent.count();
    expect(eventsAfter).toBe(eventsBefore);
    const updated = await db.prisma.invoice.findUniqueOrThrow({ where: { id: invoice.id } });
    expect(Number(updated.amountPaid)).toBe(0); // untouched
  });

  it('unknown payment intent: a refund for a PaymentIntent we never recorded a Payment for is accepted and logged, not crashed', async () => {
    const unknownPiId = randomId('pi');
    const chargeId = randomId('ch');
    const refund = chargeRefundedEvent({ id: chargeId, payment_intent: unknownPiId, amount_refunded: 5000 });
    const payload = JSON.stringify(refund);

    const result = await processStripeWebhook(payload, sign(payload));
    expect(result.received).toBe(true);
    expect(result.duplicate).toBe(false);

    const logs = await db.prisma.automationLog.findMany({ where: { entityType: 'STRIPE_WEBHOOK', entityId: chargeId, success: false } });
    expect(logs.some((l) => l.message?.includes(unknownPiId))).toBe(true);
  });

  it('a payment_intent.succeeded with no metadata.invoiceId is accepted and logged, not applied to any invoice', async () => {
    const piId = randomId('pi');
    const event = paymentIntentEvent('payment_intent.succeeded', { id: piId, amount: 5000, amount_received: 5000 });
    const payload = JSON.stringify(event);

    const result = await processStripeWebhook(payload, sign(payload));
    expect(result.received).toBe(true);

    const payment = await db.prisma.payment.findUnique({ where: { stripePaymentIntentId: piId } });
    expect(payment).toBeNull();
    const logs = await db.prisma.automationLog.findMany({ where: { entityType: 'STRIPE_WEBHOOK', entityId: piId, success: false } });
    expect(logs.length).toBeGreaterThan(0);
  });
});
