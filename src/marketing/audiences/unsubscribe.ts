import { prisma } from '@/lib/prisma';
import { recordCommunication } from '@/lib/communications/log';
import { publicBaseUrl, signToken, tokenSecret, verifyToken } from '@/marketing/security/tokens';
import type { MessagingChannel } from './rules';

/**
 * One-click unsubscribe for marketing email (CAN-SPAM opt-out mechanism).
 *
 * The link carries a signed token (MARKETING_UNSUBSCRIBE_SECRET) naming the
 * CRM contact. Using it writes an INBOUND "UNSUBSCRIBE" entry to that
 * contact's CRM timeline through the core logging function
 * (recordCommunication) — the same timeline consent.ts reads — so the
 * opt-out takes effect for every channel immediately and is visible to CRM
 * users. Marketing stores no opt-out state of its own.
 *
 * GET only renders a confirmation page with a single button; the opt-out
 * is recorded on POST. Mail security scanners prefetch GET links, and a
 * GET that unsubscribes would silently opt out customers who never clicked.
 * Links stay valid for a year (CAN-SPAM requires at least 30 days).
 */

export const UNSUBSCRIBE_TEMPLATE_KEY = 'marketing:unsubscribe';
export const UNSUBSCRIBE_TOKEN_MAX_AGE_MS = 365 * 24 * 60 * 60 * 1000;

export interface UnsubscribePayload extends Record<string, unknown> {
  v: 1;
  contactId: string;
  channel: MessagingChannel;
  campaignId: string | null;
  iat: number;
}

/** Null if MARKETING_UNSUBSCRIBE_SECRET or MARKETING_PUBLIC_BASE_URL is missing. */
export function unsubscribeUrl(input: { contactId: string; channel: MessagingChannel; campaignId: string | null }, now: Date = new Date()): string | null {
  const secret = tokenSecret('MARKETING_UNSUBSCRIBE_SECRET');
  const base = publicBaseUrl();
  if (!secret || !base) return null;
  const token = signToken({ v: 1, contactId: input.contactId, channel: input.channel, campaignId: input.campaignId, iat: now.getTime() } satisfies UnsubscribePayload, secret);
  return `${base}/api/marketing/public/unsubscribe?t=${encodeURIComponent(token)}`;
}

export function verifyUnsubscribeToken(token: string, now: Date = new Date()): UnsubscribePayload | null {
  const secret = tokenSecret('MARKETING_UNSUBSCRIBE_SECRET');
  if (!secret) return null;
  const p = verifyToken<UnsubscribePayload>(token, secret);
  if (!p || p.v !== 1 || typeof p.contactId !== 'string' || (p.channel !== 'EMAIL' && p.channel !== 'WHATSAPP') || typeof p.iat !== 'number') return null;
  if (p.iat > now.getTime() + 60_000 || now.getTime() - p.iat > UNSUBSCRIBE_TOKEN_MAX_AGE_MS) return null;
  return p;
}

export interface UnsubscribeDeps {
  db: Pick<typeof prisma, 'contact' | 'communicationLog' | 'wordPressLead'>;
  record: typeof recordCommunication;
  now(): Date;
}

export const defaultUnsubscribeDeps: UnsubscribeDeps = { db: prisma, record: recordCommunication, now: () => new Date() };

export type UnsubscribeResult = { ok: true; alreadyUnsubscribed: boolean } | { ok: false; reason: 'INVALID_TOKEN' | 'UNKNOWN_CONTACT' };

/** Idempotent: a second click (or a replayed POST) adds nothing new. */
export async function recordUnsubscribe(token: string, deps: UnsubscribeDeps = defaultUnsubscribeDeps): Promise<UnsubscribeResult> {
  const now = deps.now();
  const p = verifyUnsubscribeToken(token, now);
  if (!p) return { ok: false, reason: 'INVALID_TOKEN' };
  const contact = await deps.db.contact.findUnique({ where: { id: p.contactId }, select: { id: true, companyId: true } });
  if (!contact) return { ok: false, reason: 'UNKNOWN_CONTACT' };

  // Already unsubscribed since their latest consent? Then there's nothing to add.
  const latestLead = await deps.db.wordPressLead.findFirst({
    where: { contactId: contact.id },
    orderBy: { submittedAt: 'desc' },
    select: { submittedAt: true },
  });
  const existing = await deps.db.communicationLog.findFirst({
    where: {
      contactId: contact.id,
      direction: 'INBOUND',
      templateKey: UNSUBSCRIBE_TEMPLATE_KEY,
      ...(latestLead ? { occurredAt: { gte: latestLead.submittedAt } } : {}),
    },
    select: { id: true },
  });
  if (existing) return { ok: true, alreadyUnsubscribed: true };

  await deps.record({
    type: p.channel === 'WHATSAPP' ? 'WHATSAPP' : 'EMAIL',
    direction: 'INBOUND',
    subject: 'Marketing unsubscribe',
    body: `UNSUBSCRIBE — contact used the one-click marketing unsubscribe link${p.campaignId ? ` (campaign ${p.campaignId})` : ''}. Applies to all marketing channels.`,
    templateKey: UNSUBSCRIBE_TEMPLATE_KEY,
    // recordCommunication requires a status; for this inbound event it means "recorded".
    status: 'SENT',
    companyId: contact.companyId,
    contactId: contact.id,
  });
  return { ok: true, alreadyUnsubscribed: false };
}
