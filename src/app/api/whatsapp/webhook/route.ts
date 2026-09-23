import crypto from 'crypto';
import { NextRequest, NextResponse } from 'next/server';
import { handleInboundWebhook } from '@/lib/whatsapp/client';
import { prisma } from '@/lib/prisma';

export const runtime = 'nodejs';

/** Meta webhook verification handshake (GET) — configure this URL plus your
 * WHATSAPP_WEBHOOK_VERIFY_TOKEN in Meta App Dashboard > WhatsApp > Configuration. */
export async function GET(req: NextRequest) {
  const mode = req.nextUrl.searchParams.get('hub.mode');
  const token = req.nextUrl.searchParams.get('hub.verify_token');
  const challenge = req.nextUrl.searchParams.get('hub.challenge');

  if (mode === 'subscribe' && token === process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN) {
    return new NextResponse(challenge || '', { status: 200 });
  }
  return NextResponse.json({ error: 'Verification failed' }, { status: 403 });
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

/** Accepts a payload only if it is signed by Meta (X-Hub-Signature-256, using
 * WHATSAPP_APP_SECRET) or forwarded by a trusted relay such as n8n that sends
 * the shared secret in the `x-forward-secret` header (WHATSAPP_FORWARD_SECRET). */
function isAuthorized(req: NextRequest, rawBody: string): boolean {
  const appSecret = process.env.WHATSAPP_APP_SECRET;
  const signature = req.headers.get('x-hub-signature-256');
  if (appSecret && signature) {
    const expected = 'sha256=' + crypto.createHmac('sha256', appSecret).update(rawBody).digest('hex');
    if (safeEqual(signature, expected)) return true;
  }

  const forwardSecret = process.env.WHATSAPP_FORWARD_SECRET;
  const provided = req.headers.get('x-forward-secret');
  if (forwardSecret && provided && safeEqual(provided, forwardSecret)) return true;

  return false;
}

/** Receives inbound WhatsApp messages and delivery status updates from Meta. */
export async function POST(req: NextRequest) {
  const rawBody = await req.text();
  if (!isAuthorized(req, rawBody)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let payload: unknown;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ error: 'Invalid payload' }, { status: 400 });
  }

  // A genuine processing failure (bad DB connection, an unexpected payload
  // shape that breaks before any per-message handling even starts) must
  // not be swallowed: it's logged where it's actually visible, and the
  // route returns a non-2xx so Meta retries delivery instead of the
  // message being silently lost. Per-message failures within an otherwise
  // successful batch are handled and logged individually inside
  // handleInboundWebhook() and still result in a 200 here (see its
  // comment) — Meta's retry is for "you never got this", not "some of
  // several messages had a problem".
  let result: { stored: number; failed: number };
  try {
    result = await handleInboundWebhook(payload);
  } catch (err) {
    console.error('WhatsApp webhook error', err);
    await prisma.automationLog
      .create({
        data: {
          entityType: 'WHATSAPP_WEBHOOK',
          entityId: 'batch',
          success: false,
          message: `WhatsApp webhook processing failed: ${String(err)}`,
        },
      })
      .catch(() => undefined);
    return NextResponse.json({ error: 'Processing failed' }, { status: 500 });
  }

  return NextResponse.json({ ok: true, ...result });
}
