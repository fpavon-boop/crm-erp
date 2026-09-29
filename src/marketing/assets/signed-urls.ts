import crypto from 'crypto';
import { safeEqual } from '@/lib/crypto';
import { prisma } from '@/lib/prisma';
import { readStoredFile } from '@/lib/uploads';
import { publicBaseUrl, tokenSecret } from '@/marketing/security/tokens';

/**
 * Time-limited public URLs for marketing media, so Meta/TikTok (which
 * download media themselves) and n8n can fetch product images that only
 * exist behind the CRM's login.
 *
 *   {base}/api/marketing/public/media/{assetId}?exp={unix}&sig={hmac}
 *   sig = HMAC-SHA256(MARKETING_MEDIA_URL_SECRET, "media:{assetId}:{exp}")
 *
 * The route serves only active IMAGE/VIDEO marketing assets. For
 * ERP-linked product images it reads the core file READ-ONLY and streams
 * it; nothing is copied or modified. Default lifetime is 24h, long enough
 * for scheduled dispatch and platform fetch, short enough that a leaked URL
 * goes stale.
 */

export const DEFAULT_MEDIA_URL_TTL_SEC = 24 * 60 * 60;
export const MAX_MEDIA_URL_TTL_SEC = 7 * 24 * 60 * 60;

function sign(secret: string, assetId: string, exp: number): string {
  return crypto.createHmac('sha256', secret).update(`media:${assetId}:${exp}`).digest('hex');
}

/** Null if MARKETING_MEDIA_URL_SECRET or MARKETING_PUBLIC_BASE_URL is missing. */
export function signedMediaUrl(assetId: string, options: { ttlSec?: number; now?: Date } = {}): string | null {
  const secret = tokenSecret('MARKETING_MEDIA_URL_SECRET');
  const base = publicBaseUrl();
  if (!secret || !base) return null;
  const ttl = Math.min(Math.max(60, options.ttlSec ?? DEFAULT_MEDIA_URL_TTL_SEC), MAX_MEDIA_URL_TTL_SEC);
  const exp = Math.floor((options.now ?? new Date()).getTime() / 1000) + ttl;
  return `${base}/api/marketing/public/media/${encodeURIComponent(assetId)}?exp=${exp}&sig=${sign(secret, assetId, exp)}`;
}

export function verifyMediaSignature(assetId: string, exp: string | null, sig: string | null, now: Date = new Date()): boolean {
  const secret = tokenSecret('MARKETING_MEDIA_URL_SECRET');
  if (!secret || !exp || !sig || !/^\d{1,12}$/.test(exp) || !/^[a-f0-9]{64}$/.test(sig)) return false;
  if (Number(exp) < Math.floor(now.getTime() / 1000)) return false;
  if (Number(exp) - Math.floor(now.getTime() / 1000) > MAX_MEDIA_URL_TTL_SEC) return false;
  return safeEqual(sig, sign(secret, assetId, Number(exp)));
}

/** Resolver used by publishing and video payloads: public https assets pass
 * through; anything else (ERP-linked images) gets a signed URL, or null if
 * signing isn't configured (dispatch then blocks, fail closed). */
export function resolvePublicAssetUrl(asset: { id: string; url: string }, now?: Date): string | null {
  return asset.url.startsWith('https://') ? asset.url : signedMediaUrl(asset.id, { now });
}

// =============================================================================
// Serving
// =============================================================================

export interface MediaServeDeps {
  db: Pick<typeof prisma, 'marketingAsset' | 'document'>;
  readFile(storedPath: string): Promise<Buffer>;
  now(): Date;
}

export const defaultMediaServeDeps: MediaServeDeps = { db: prisma, readFile: readStoredFile, now: () => new Date() };

export type MediaServeResult =
  | { status: 200; body: Buffer; headers: Record<string, string> }
  | { status: 302; headers: Record<string, string> }
  | { status: 403 | 404; error: string };

const SERVABLE = /^(image\/(jpeg|png|webp|gif)|video\/(mp4|quicktime|webm))$/;

export async function serveSignedMedia(
  assetId: string,
  query: { exp: string | null; sig: string | null },
  deps: MediaServeDeps = defaultMediaServeDeps
): Promise<MediaServeResult> {
  if (!verifyMediaSignature(assetId, query.exp, query.sig, deps.now())) return { status: 403, error: 'Invalid or expired link' };
  const asset = await deps.db.marketingAsset.findUnique({ where: { id: assetId } });
  if (!asset || asset.archivedAt || (asset.type !== 'IMAGE' && asset.type !== 'VIDEO')) return { status: 404, error: 'Not found' };

  if (asset.url.startsWith('https://')) return { status: 302, headers: { location: asset.url, 'cache-control': 'no-store' } };
  if (asset.source !== 'ERP_DOCUMENT' || !asset.sourceDocumentId) return { status: 404, error: 'Not found' };

  // Read-only access to the core Document row and file.
  const doc = await deps.db.document.findUnique({
    where: { id: asset.sourceDocumentId },
    select: { entityType: true, storedPath: true, mimeType: true },
  });
  if (!doc || doc.entityType !== 'PRODUCT' || !SERVABLE.test(doc.mimeType.toLowerCase())) return { status: 404, error: 'Not found' };
  const body = await deps.readFile(doc.storedPath);
  return {
    status: 200,
    body,
    headers: {
      'content-type': doc.mimeType.toLowerCase(),
      'content-length': String(body.length),
      'cache-control': 'private, max-age=300',
      'x-content-type-options': 'nosniff',
      'content-disposition': 'inline',
    },
  };
}
