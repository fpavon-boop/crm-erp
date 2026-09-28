import type { MessagingChannel } from './rules';

/**
 * Consent is READ from the CRM, never stored by marketing.
 *
 * A contact may receive marketing on a channel only when ALL hold:
 * 1. CRM consent — their most recent WordPressLead has consentGiven = true
 *    (the latest submission governs, so a later form without consent
 *    withdraws it). No lead on file = no consent (fail closed).
 * 2. No opt-out on the CRM timeline — no INBOUND email/WhatsApp in
 *    CommunicationLog after that consent whose text is an opt-out
 *    ("STOP", "unsubscribe", "BAJA", …). One opt-out covers every channel.
 * 3. A usable address for the channel on the CRM contact.
 * 4. WhatsApp only: an inbound WhatsApp message in the last 24 hours. The
 *    core send path sends free-form text, which Meta only permits inside
 *    the 24-hour customer-service window; outside it a Meta-approved
 *    template is required, which the core service does not send yet.
 */

export type ExclusionReason = 'NO_CONSENT_RECORD' | 'CONSENT_NOT_GIVEN' | 'OPTED_OUT' | 'NO_ADDRESS' | 'OUTSIDE_WHATSAPP_WINDOW';

export const OPT_OUT_RE =
  /\b(stop|unsubscribe|opt[\s-]?out|remove me|baja|darme de baja|cancelar (la )?suscripci[oó]n|no m[aá]s (mensajes|correos))\b/i;

export const WHATSAPP_WINDOW_MS = 24 * 60 * 60 * 1000;

export interface ConsentContact {
  id: string;
  email: string | null;
  phone: string | null;
  mobile: string | null;
}

export interface ConsentLead {
  contactId: string | null;
  consentGiven: boolean;
  submittedAt: Date;
}

export interface TimelineInbound {
  contactId: string | null;
  type: string;
  subject: string | null;
  body: string | null;
  occurredAt: Date;
}

export type ConsentDecision =
  | { eligible: true; address: string; consentAt: Date }
  | { eligible: false; reason: ExclusionReason };

/** Only the first 300 chars: an opt-out is a short reply, not a word buried in a long thread. */
export function isOptOutMessage(m: Pick<TimelineInbound, 'subject' | 'body'>): boolean {
  const text = `${m.subject ?? ''}\n${m.body ?? ''}`.trim().slice(0, 300);
  return OPT_OUT_RE.test(text);
}

export function decideConsent(
  contact: ConsentContact,
  channel: MessagingChannel,
  leads: ConsentLead[],
  inbound: TimelineInbound[],
  now: Date
): ConsentDecision {
  const latest = leads.filter((l) => l.contactId === contact.id).sort((a, b) => b.submittedAt.getTime() - a.submittedAt.getTime())[0];
  if (!latest) return { eligible: false, reason: 'NO_CONSENT_RECORD' };
  if (!latest.consentGiven) return { eligible: false, reason: 'CONSENT_NOT_GIVEN' };

  const mine = inbound.filter((m) => m.contactId === contact.id);
  if (mine.some((m) => m.occurredAt >= latest.submittedAt && isOptOutMessage(m))) return { eligible: false, reason: 'OPTED_OUT' };

  const address = channel === 'EMAIL' ? contact.email?.trim() : (contact.mobile?.trim() || contact.phone?.trim());
  if (!address) return { eligible: false, reason: 'NO_ADDRESS' };

  if (channel === 'WHATSAPP') {
    const lastInbound = mine.filter((m) => m.type === 'WHATSAPP').reduce<Date | null>((d, m) => (!d || m.occurredAt > d ? m.occurredAt : d), null);
    if (!lastInbound || now.getTime() - lastInbound.getTime() > WHATSAPP_WINDOW_MS) return { eligible: false, reason: 'OUTSIDE_WHATSAPP_WINDOW' };
  }
  return { eligible: true, address, consentAt: latest.submittedAt };
}
