import { NextRequest, NextResponse } from 'next/server';
import { serveSignedMedia } from '@/marketing/assets/signed-urls';

export const runtime = 'nodejs';

/** Public, time-limited media URL (authenticated by its HMAC signature) for
 * Meta/TikTok/n8n to fetch marketing images and videos. See
 * src/marketing/assets/signed-urls.ts. */
export async function GET(req: NextRequest, { params }: { params: { assetId: string } }) {
  const result = await serveSignedMedia(params.assetId, {
    exp: req.nextUrl.searchParams.get('exp'),
    sig: req.nextUrl.searchParams.get('sig'),
  });
  if (result.status === 200) return new NextResponse(new Uint8Array(result.body), { status: 200, headers: result.headers });
  if (result.status === 302) return new NextResponse(null, { status: 302, headers: result.headers });
  return NextResponse.json({ error: result.error }, { status: result.status, headers: { 'cache-control': 'no-store' } });
}
