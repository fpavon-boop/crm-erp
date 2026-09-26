import type { RelatedEntityType } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { sendSystemEmail } from '@/lib/email/smtp';
import { sendText } from '@/lib/whatsapp/client';
import { claimIdempotencyKey, recordIdempotentResult } from '@/lib/automations/idempotency';
import { recordCommunication } from './log';
import { textToHtml } from './templates';

export interface SendCommunicationInput {
  channel: 'email' | 'whatsapp';
  /** Email address or phone number the human reviewing the draft has
   * confirmed to send to — never inferred silently at send time. */
  to: string;
  subject?: string | null;
  /** The final, human-reviewed plain-text body — may or may not match the
   * template's original rendering verbatim (see docs/CUSTOMER_COMMUNICATION.md
   * "Draft and edit before send"). */
  body: string;
  templateKey?: string | null;
  companyId?: string | null;
  contactId?: string | null;
  relatedType?: RelatedEntityType | null;
  relatedId?: string | null;
  userId?: string | null;
  /** Phase 13: a client-generated key (one crypto.randomUUID() per compose
   * of the form, resent verbatim on any retry of the same click) — a
   * network retry or a double-click resubmitting the exact same draft
   * finds the key already claimed and gets back the original send's
   * outcome instead of sending the message a second time. Optional only
   * for backward compatibility with any caller that predates this; the
   * UI always supplies one. */
  idempotencyKey?: string | null;
}

export interface SendCommunicationResult {
  sent: boolean;
  reason?: string;
  communicationLogId: string;
}

type EmailSender = typeof sendSystemEmail;
type WhatsAppSender = typeof sendText;

/**
 * The one send path behind the "Send communication" form on the Company
 * and Sales Order pages (Phase 10). Never called automatically — every
 * invocation follows a human clicking Send on an already-reviewed draft
 * (see docs/CUSTOMER_COMMUNICATION.md "Human approval"). Always writes
 * exactly one CommunicationLog row, whether the underlying send succeeded
 * or failed, so a failed send is never silently lost (the same "no
 * invisible failures" discipline as SYSTEM_AUDIT.md C3).
 *
 * `deps` lets tests inject a stub sender instead of making a real
 * network/SMTP/WhatsApp-API call — the same seam
 * src/lib/automations/tick-lock.ts's `work` parameter already established
 * for exactly this reason.
 */
export async function sendCommunication(
  input: SendCommunicationInput,
  deps: { emailSender?: EmailSender; whatsappSender?: WhatsAppSender } = {}
): Promise<SendCommunicationResult> {
  if (input.idempotencyKey) {
    const claim = await claimIdempotencyKey(input.idempotencyKey, 'communication_send');
    if (!claim.claimed) {
      const priorLog = claim.existingResultRef
        ? await prisma.communicationLog.findUnique({ where: { id: claim.existingResultRef } })
        : null;
      if (priorLog) {
        return { sent: priorLog.status === 'SENT', reason: priorLog.status === 'SENT' ? undefined : 'Already sent (idempotent no-op)', communicationLogId: priorLog.id };
      }
      // The winning call hasn't finished recording its result yet (a very
      // tight race) — there is nothing to safely do but say so rather than
      // send a second time or fabricate a communicationLogId.
      return { sent: false, reason: 'A send with this key is already in progress', communicationLogId: '' };
    }
  }

  const emailSender = deps.emailSender ?? sendSystemEmail;
  const whatsappSender = deps.whatsappSender ?? sendText;

  let sent = false;
  let reason: string | undefined;

  try {
    if (input.channel === 'email') {
      const result = await emailSender({
        to: input.to,
        subject: input.subject || '(no subject)',
        html: textToHtml(input.body),
      });
      sent = result.sent;
      reason = result.reason;
    } else {
      await whatsappSender({
        to: input.to,
        body: input.body,
        companyId: input.companyId,
        contactId: input.contactId,
      });
      sent = true;
    }
  } catch (err) {
    sent = false;
    reason = err instanceof Error ? err.message : String(err);
  }

  const log = await recordCommunication({
    type: input.channel === 'email' ? 'EMAIL' : 'WHATSAPP',
    direction: 'OUTBOUND',
    subject: input.channel === 'email' ? input.subject ?? null : null,
    body: input.body,
    recipient: input.to,
    templateKey: input.templateKey ?? null,
    status: sent ? 'SENT' : 'FAILED',
    companyId: input.companyId ?? null,
    contactId: input.contactId ?? null,
    relatedType: input.relatedType ?? null,
    relatedId: input.relatedId ?? null,
    userId: input.userId ?? null,
  });
  if (input.idempotencyKey) await recordIdempotentResult(input.idempotencyKey, log.id);

  return { sent, reason, communicationLogId: log.id };
}
