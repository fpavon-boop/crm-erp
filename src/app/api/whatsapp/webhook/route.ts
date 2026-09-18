import { NextRequest, NextResponse } from 'next/server';
import { handleInboundWebhook } from '@/lib/whatsapp/client';

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

/** Receives inbound WhatsApp messages and delivery status updates from Meta. */
export async function POST(req: NextRequest) {
  const payload = await req.json().catch(() => null);
  if (!payload) return NextResponse.json({ error: 'Invalid payload' }, { status: 400 });

  await handleInboundWebhook(payload).catch((err) => console.error('WhatsApp webhook error', err));

  return NextResponse.json({ ok: true });
}
