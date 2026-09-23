import { NextRequest, NextResponse } from 'next/server';
import { processStripeWebhook, InvalidStripeSignatureError } from '@/lib/stripe/webhook';
import { prisma } from '@/lib/prisma';

export const runtime = 'nodejs';

/**
 * Receives Stripe webhook events. Configure this URL plus STRIPE_SECRET_KEY
 * and STRIPE_WEBHOOK_SECRET (see docs/STRIPE_INTEGRATION.md) in the Stripe
 * Dashboard's Webhooks settings.
 *
 * An invalid/missing signature is rejected (400) before anything in the
 * body is trusted or acted on — this is the ONLY authentication for this
 * endpoint; there is deliberately no session/API-key check, since Stripe
 * itself never carries this app's session cookies.
 */
export async function POST(req: NextRequest) {
  const rawBody = await req.text();
  const signature = req.headers.get('stripe-signature');

  try {
    const result = await processStripeWebhook(rawBody, signature);
    return NextResponse.json(result);
  } catch (err) {
    if (err instanceof InvalidStripeSignatureError) {
      return NextResponse.json({ error: 'Invalid signature' }, { status: 400 });
    }

    // A genuine processing failure (bad DB connection, an unexpected event
    // shape) must not be swallowed: logged where it's visible, and a
    // non-2xx response so Stripe retries delivery instead of the event
    // being silently lost.
    console.error('Stripe webhook error', err);
    await prisma.automationLog
      .create({
        data: {
          entityType: 'STRIPE_WEBHOOK',
          entityId: 'processing',
          success: false,
          message: `Stripe webhook processing failed: ${String(err)}`,
        },
      })
      .catch(() => undefined);
    return NextResponse.json({ error: 'Processing failed' }, { status: 500 });
  }
}
