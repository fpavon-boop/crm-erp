import crypto from 'crypto';
import { safeEqual } from '@/lib/crypto';

/**
 * Compact HMAC-signed tokens for public, unauthenticated marketing links
 * (one-click unsubscribe, time-limited media URLs). Format:
 *   base64url(JSON payload) "." base64url(HMAC-SHA256(secret, payloadPart))
 * Each use gets its own env secret, so a leaked media secret can't forge
 * unsubscribe links and vice versa.
 */

export const MIN_TOKEN_SECRET_LENGTH = 32;

export type TokenSecretName = 'MARKETING_UNSUBSCRIBE_SECRET' | 'MARKETING_MEDIA_URL_SECRET';

/** Null (not a throw) when unset/short: callers fail closed with a clear error. */
export function tokenSecret(name: TokenSecretName): string | null {
  const v = process.env[name];
  return v && v.length >= MIN_TOKEN_SECRET_LENGTH ? v : null;
}

export function publicBaseUrl(): string | null {
  const base = process.env.MARKETING_PUBLIC_BASE_URL;
  return base && /^https:\/\//.test(base) ? base.replace(/\/$/, '') : null;
}

function mac(secret: string, data: string): string {
  return crypto.createHmac('sha256', secret).update(data).digest('base64url');
}

export function signToken(payload: Record<string, unknown>, secret: string): string {
  const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  return `${body}.${mac(secret, body)}`;
}

export function verifyToken<T extends Record<string, unknown>>(token: string, secret: string): T | null {
  if (typeof token !== 'string' || token.length > 2048) return null;
  const [body, sig, extra] = token.split('.');
  if (!body || !sig || extra !== undefined) return null;
  if (!safeEqual(sig, mac(secret, body))) return null;
  try {
    const parsed = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as T) : null;
  } catch {
    return null;
  }
}
