import { NextRequest, NextResponse } from 'next/server';
import { handleMetricsWebhook } from '@/marketing/integrations/metrics-inbound';

export const runtime = 'nodejs';

/** Signed n8n engagement metrics per post (views, clicks, likes…). Public at
 * the middleware level; authenticated by HMAC in handleMetricsWebhook. */
export async function POST(req: NextRequest) {
  const rawBody = await req.text();
  const res = await handleMetricsWebhook({ rawBody, headers: req.headers });
  return NextResponse.json(res.body, { status: res.status });
}
