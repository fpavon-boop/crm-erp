import { NextRequest, NextResponse } from 'next/server';
import { SIGNATURE_HEADER, TIMESTAMP_HEADER, verifyWebhook } from '@/marketing/security/signing';
import { requireMarketingAction } from '@/marketing/security/guard';
import { runMarketingDispatchTick } from '@/marketing/scheduling/dispatcher';

export const runtime = 'nodejs';
export const maxDuration = 300;

/**
 * Runs one marketing dispatcher tick. Called every minute by a signed n8n
 * schedule workflow (HMAC with MARKETING_N8N_INBOUND_SECRET), or manually by
 * an ADMIN session. Overlapping calls are safe: the marketing lock makes a
 * concurrent tick a no-op ({ ran: false, reason: 'LOCKED' }).
 */
export async function POST(req: NextRequest) {
  const rawBody = await req.text();
  const secret = process.env.MARKETING_N8N_INBOUND_SECRET;
  const signed =
    !!secret &&
    secret.length >= 32 &&
    verifyWebhook({ rawBody, secret, timestamp: req.headers.get(TIMESTAMP_HEADER), signature: req.headers.get(SIGNATURE_HEADER) }).ok;

  if (!signed) {
    const ctx = await requireMarketingAction('schedule');
    if (ctx instanceof NextResponse) return ctx;
  }
  const result = await runMarketingDispatchTick();
  return NextResponse.json(result, { status: result.ran || result.reason === 'LOCKED' ? 200 : 503 });
}
