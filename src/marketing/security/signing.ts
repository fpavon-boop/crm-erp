import crypto from 'crypto';
import { safeEqual } from '@/lib/crypto';

/**
 * HMAC-SHA256 signing for CRM ⇄ n8n webhooks (architecture doc §4).
 *
 * Signature = "sha256=" + hex(HMAC(secret, `${timestamp}.${rawBody}`)).
 * Binding the timestamp into the MAC plus a tolerance window stops replay of
 * a captured request; inbound callbacks must additionally dedupe on eventId.
 *
 * Outbound and inbound use DIFFERENT secrets (MARKETING_N8N_OUTBOUND_SECRET /
 * MARKETING_N8N_INBOUND_SECRET) so a leak of one direction doesn't let an
 * attacker forge the other.
 */

export const SIGNATURE_HEADER = 'x-mkt-signature';
export const TIMESTAMP_HEADER = 'x-mkt-timestamp';
export const JOB_ID_HEADER = 'x-mkt-job-id';

const MIN_SECRET_LENGTH = 32;
const DEFAULT_TOLERANCE_SECONDS = 300;

export type SigningSecretName = 'MARKETING_N8N_OUTBOUND_SECRET' | 'MARKETING_N8N_INBOUND_SECRET';

/** Reads a signing secret from env; fails closed if missing or too short. */
export function getSigningSecret(name: SigningSecretName): string {
  const value = process.env[name];
  if (!value || value.length < MIN_SECRET_LENGTH) {
    throw new Error(`${name} must be set to at least ${MIN_SECRET_LENGTH} characters`);
  }
  return value;
}

function computeSignature(secret: string, timestamp: string, rawBody: string): string {
  return 'sha256=' + crypto.createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex');
}

export function signWebhook(
  rawBody: string,
  secret: string,
  nowMs: number = Date.now()
): { timestamp: string; signature: string } {
  if (secret.length < MIN_SECRET_LENGTH) throw new Error('Signing secret is too short');
  const timestamp = Math.floor(nowMs / 1000).toString();
  return { timestamp, signature: computeSignature(secret, timestamp, rawBody) };
}

export type WebhookVerification =
  | { ok: true }
  | { ok: false; reason: 'MISSING_HEADERS' | 'BAD_TIMESTAMP' | 'STALE' | 'BAD_SIGNATURE' };

export function verifyWebhook(params: {
  rawBody: string;
  secret: string;
  timestamp: string | null;
  signature: string | null;
  toleranceSeconds?: number;
  nowMs?: number;
}): WebhookVerification {
  const { rawBody, secret, timestamp, signature } = params;
  if (!timestamp || !signature) return { ok: false, reason: 'MISSING_HEADERS' };
  if (!/^\d{1,12}$/.test(timestamp)) return { ok: false, reason: 'BAD_TIMESTAMP' };

  const nowSec = Math.floor((params.nowMs ?? Date.now()) / 1000);
  const tolerance = params.toleranceSeconds ?? DEFAULT_TOLERANCE_SECONDS;
  if (Math.abs(nowSec - Number(timestamp)) > tolerance) return { ok: false, reason: 'STALE' };

  const expected = computeSignature(secret, timestamp, rawBody);
  return safeEqual(signature, expected) ? { ok: true } : { ok: false, reason: 'BAD_SIGNATURE' };
}
