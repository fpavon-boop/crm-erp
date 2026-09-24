import Stripe from 'stripe';
import { prisma } from '@/lib/prisma';
import { Prisma } from '@prisma/client';
import { deriveInvoiceStatus } from '@/lib/accounts-receivable';

type Db = typeof prisma | Prisma.TransactionClient;

export class InvalidStripeSignatureError extends Error {
  constructor(message = 'Invalid Stripe webhook signature') {
    super(message);
    this.name = 'InvalidStripeSignatureError';
  }
}

/** Reads the Stripe secret key strictly from the environment — never
 * hardcoded, never logged. Throws (rather than silently proceeding
 * unauthenticated) if it isn't configured. */
function getStripeClient(): Stripe {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw new Error('STRIPE_SECRET_KEY is not configured');
  return new Stripe(key);
}

/** Verifies the raw request body against Stripe's `stripe-signature`
 * header using the webhook signing secret (also read strictly from the
 * environment). This is the ONLY way an incoming request is trusted —
 * nothing about an event's contents is acted on until this passes. Every
 * failure mode (missing header, wrong secret, tampered body, expired
 * timestamp, malformed payload) throws InvalidStripeSignatureError, which
 * the route maps to an HTTP 400 without processing anything. */
export function verifyStripeSignature(rawBody: string, signatureHeader: string | null): Stripe.Event {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) throw new Error('STRIPE_WEBHOOK_SECRET is not configured');
  if (!signatureHeader) throw new InvalidStripeSignatureError('Missing stripe-signature header');
  try {
    return getStripeClient().webhooks.constructEvent(rawBody, signatureHeader, secret);
  } catch (err) {
    throw new InvalidStripeSignatureError(err instanceof Error ? err.message : String(err));
  }
}

/** Stripe amounts are integer cents; converts to a decimal dollar amount
 * without floating-point drift (999/100 done via plain division can land
 * on 9.99000000000001-style values once it reaches a Decimal column). */
function centsToAmount(cents: number): number {
  return Number((cents / 100).toFixed(2));
}

async function logStripeIssue(db: Db, entityId: string | undefined, message: string) {
  await db.automationLog
    .create({ data: { entityType: 'STRIPE_WEBHOOK', entityId, success: false, message } })
    .catch(() => undefined);
}

/** A successful (or partially-successful, in the sense of "less than the
 * full invoice total") PaymentIntent. Reconciliation requires the
 * PaymentIntent to carry `metadata.invoiceId` — set when the PaymentIntent
 * was created — identifying which Invoice it pays. A PaymentIntent with no
 * such metadata, or one naming an Invoice this app doesn't have, is
 * accepted (2xx, so Stripe doesn't retry forever) but not applied to
 * anything, and is logged for visibility. See docs/STRIPE_INTEGRATION.md
 * "Payment lifecycle". */
async function handlePaymentSucceeded(tx: Db, event: Stripe.Event) {
  const pi = event.data.object as Stripe.PaymentIntent;
  const invoiceId = pi.metadata?.invoiceId;
  if (!invoiceId) {
    await logStripeIssue(tx, pi.id, `payment_intent.succeeded (${pi.id}) has no metadata.invoiceId — cannot reconcile to an invoice.`);
    return;
  }

  const invoice = await tx.invoice.findUnique({ where: { id: invoiceId } });
  if (!invoice) {
    await logStripeIssue(tx, pi.id, `payment_intent.succeeded (${pi.id}) references unknown invoice ${invoiceId}.`);
    return;
  }

  // Belt-and-suspenders idempotency at the PaymentIntent level, alongside
  // the StripeWebhookEvent id guard the caller already applied: a
  // PaymentIntent should only ever produce one Payment row.
  const existing = await tx.payment.findUnique({ where: { stripePaymentIntentId: pi.id } });
  if (existing) return;

  const amount = centsToAmount(pi.amount_received);
  await tx.payment.create({
    data: {
      invoiceId: invoice.id,
      amount,
      method: 'stripe',
      reference: pi.id,
      stripePaymentIntentId: pi.id,
      stripeChargeId: typeof pi.latest_charge === 'string' ? pi.latest_charge : (pi.latest_charge?.id ?? null),
    },
  });

  const newPaid = Number(invoice.amountPaid) + amount;
  await tx.invoice.update({
    where: { id: invoice.id },
    data: {
      amountPaid: newPaid,
      status: deriveInvoiceStatus({ status: invoice.status, total: Number(invoice.total), amountPaid: newPaid, dueDate: invoice.dueDate }),
    },
  });
}

/** A failed PaymentIntent never touches Payment/Invoice — no money moved,
 * so nothing to reconcile — but is logged so a failed customer payment is
 * visible to staff instead of silently vanishing. */
async function handlePaymentFailed(tx: Db, event: Stripe.Event) {
  const pi = event.data.object as Stripe.PaymentIntent;
  const invoiceId = pi.metadata?.invoiceId;
  const reason = pi.last_payment_error?.message || 'unknown reason';
  await logStripeIssue(
    tx,
    pi.id,
    `Stripe payment failed for PaymentIntent ${pi.id}${invoiceId ? ` (invoice ${invoiceId})` : ''}: ${reason}`
  );
}

/** A refund (full or partial) against a Charge. Matched back to our
 * Payment via the charge's `payment_intent` id — a charge whose
 * PaymentIntent we never recorded a Payment for (an "unknown payment
 * intent") is accepted but logged, not silently dropped. Uses the
 * charge's own cumulative `amount_refunded` (not a delta computed from the
 * event alone) so that re-deliveries or multiple partial refunds on the
 * same charge always converge on the correct total, rather than
 * double-subtracting. */
async function handleChargeRefunded(tx: Db, event: Stripe.Event) {
  const charge = event.data.object as Stripe.Charge;
  const paymentIntentId = typeof charge.payment_intent === 'string' ? charge.payment_intent : charge.payment_intent?.id;
  if (!paymentIntentId) {
    await logStripeIssue(tx, charge.id, `charge.refunded (${charge.id}) has no linked PaymentIntent.`);
    return;
  }

  const payment = await tx.payment.findUnique({ where: { stripePaymentIntentId: paymentIntentId } });
  if (!payment) {
    await logStripeIssue(
      tx,
      charge.id,
      `charge.refunded (${charge.id}) references unknown PaymentIntent ${paymentIntentId} — no matching Payment on file.`
    );
    return;
  }

  const newRefundedAmount = centsToAmount(charge.amount_refunded);
  const delta = newRefundedAmount - Number(payment.refundedAmount);
  if (delta <= 0) return; // already reflects this refund state — duplicate/out-of-order delivery, not a new refund

  await tx.payment.update({ where: { id: payment.id }, data: { refundedAmount: newRefundedAmount } });

  const invoice = await tx.invoice.findUniqueOrThrow({ where: { id: payment.invoiceId } });
  const newPaid = Math.max(0, Number(invoice.amountPaid) - delta);
  await tx.invoice.update({
    where: { id: invoice.id },
    data: {
      amountPaid: newPaid,
      status: deriveInvoiceStatus({ status: invoice.status, total: Number(invoice.total), amountPaid: newPaid, dueDate: invoice.dueDate }),
    },
  });
}

export interface ProcessWebhookResult {
  received: boolean;
  /** True when this exact Stripe event id was already processed before —
   * nothing was applied a second time. */
  duplicate: boolean;
  eventType: string;
}

/**
 * Verifies and processes one Stripe webhook delivery. The whole thing — the
 * idempotency check, marking the event processed, and whatever
 * Payment/Invoice mutation the event implies — runs inside one
 * `prisma.$transaction`, so a crash partway through can never leave an
 * event marked "processed" without its effect applied, or vice versa.
 *
 * Idempotency: `event.id` is inserted into StripeWebhookEvent (unique) as
 * the FIRST write inside the transaction. If that insert violates the
 * unique constraint, this exact event was already processed — the
 * function returns `{ duplicate: true }` immediately without touching
 * Payment/Invoice a second time. This is what makes Stripe's at-least-once
 * webhook delivery (the same event redelivered after a timeout, a slow
 * response, or a deliberate retry) safe.
 */
export async function processStripeWebhook(
  rawBody: string,
  signatureHeader: string | null
): Promise<ProcessWebhookResult> {
  const event = verifyStripeSignature(rawBody, signatureHeader);

  return prisma.$transaction(async (tx) => {
    try {
      await tx.stripeWebhookEvent.create({
        data: {
          stripeEventId: event.id,
          type: event.type,
          payload: event as unknown as Prisma.InputJsonValue,
        },
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        return { received: true, duplicate: true, eventType: event.type };
      }
      throw err;
    }

    switch (event.type) {
      case 'payment_intent.succeeded':
        await handlePaymentSucceeded(tx, event);
        break;
      case 'payment_intent.payment_failed':
        await handlePaymentFailed(tx, event);
        break;
      case 'charge.refunded':
        await handleChargeRefunded(tx, event);
        break;
      default:
        // Unhandled event types are accepted (2xx, so Stripe doesn't keep
        // retrying) but not acted on. See docs/STRIPE_INTEGRATION.md
        // "Known limitations" for exactly which types are handled.
        break;
    }

    return { received: true, duplicate: false, eventType: event.type };
  });
}
