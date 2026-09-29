import { NextRequest, NextResponse } from 'next/server';
import { handleN8nWebhook } from '@/marketing/integrations/n8n-inbound';

export const runtime = 'nodejs';

/** Signed n8n callbacks (post results, render progress). Public at the
 * middleware level; authenticated by HMAC in handleN8nWebhook. */
export async function POST(req: NextRequest) {
  const rawBody = await req.text();
  const res = await handleN8nWebhook({ rawBody, headers: req.headers });
  return NextResponse.json(res.body, { status: res.status });
}
