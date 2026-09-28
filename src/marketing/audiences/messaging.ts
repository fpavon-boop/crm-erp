import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { toNumber } from '@/lib/format';
import { sendCommunication } from '@/lib/communications/send';
import { canPerform } from '@/marketing/security/rbac';
import { marketingErrors } from '@/marketing/errors';
import { evaluateCampaignSafeguards, defaultSafeguardChecks, type SafeguardChecks } from '@/marketing/campaigns/safeguard-gate';
import { CampaignSafeguardError } from '@/marketing/campaigns/errors';
import { resolveAudience, type AudienceDeps } from './audience-service';

/**
 * Direct email / WhatsApp campaign messages.
 *
 * Every message goes through the CORE communications service
 * (src/lib/communications/send.ts → sendCommunication): the same sender,
 * WhatsApp account and CommunicationLog timeline the CRM already uses, and
 * its idempotency keys. Marketing never sends, stores recipient lists, or
 * records consent itself.
 *
 * Gate: ADMIN `publish`; campaign APPROVED (or later); content APPROVED,
 * without blocking compliance findings, of the matching message type;
 * stock + margin safeguards re-run and must not BLOCK. Recipients are
 * resolved from the CRM at send time (audience-service.ts, consent.ts).
 *
 * Idempotency: one key per (content version, contact) — re-running the same
 * send (a retry, a double click, a second batch) never messages anyone twice.
 */

export const MAX_RECIPIENTS_PER_CALL = 500;

const FOOTER: Record<'en' | 'es', Record<'EMAIL' | 'WHATSAPP', string>> = {
  en: {
    EMAIL: 'You are receiving this because you opted in on our website. Reply STOP to unsubscribe.',
    WHATSAPP: 'Reply STOP to stop receiving these messages.',
  },
  es: {
    EMAIL: 'Recibe este correo porque lo autorizó en nuestro sitio web. Responda BAJA para darse de baja.',
    WHATSAPP: 'Responda BAJA para no recibir más mensajes.',
  },
};

export interface MessagingDeps {
  /** idempotencyKey is the core table, read-only here (see the send loop). */
  db: Pick<typeof prisma, 'marketingCampaign' | 'marketingContent' | 'campaignApproval' | 'idempotencyKey'> & AudienceDeps['db'];
  audience: AudienceDeps;
  safeguards: SafeguardChecks;
  send: typeof sendCommunication;
  /** Passed straight to the core service (tests inject stub senders). */
  senderDeps?: Parameters<typeof sendCommunication>[1];
  now(): Date;
}

export const defaultMessagingDeps: MessagingDeps = {
  db: prisma,
  audience: { db: prisma, now: () => new Date() },
  safeguards: defaultSafeguardChecks,
  send: sendCommunication,
  now: () => new Date(),
};

export function messageIdempotencyKey(contentId: string, contentVersion: number, contactId: string): string {
  return `mkt-msg:${contentId}:v${contentVersion}:${contactId}`;
}

export interface CampaignMessageResult {
  matched: number;
  eligible: number;
  attempted: number;
  sent: number;
  alreadySent: number;
  failed: number;
  remaining: number;
  excluded: Record<string, number>;
}

export async function sendCampaignMessage(
  input: { campaignId: string; contentId: string; audienceId: string },
  actor: { userId: string; role: string },
  deps: MessagingDeps = defaultMessagingDeps
): Promise<CampaignMessageResult> {
  if (!canPerform(actor.role, 'publish')) throw marketingErrors.forbidden(`Role ${actor.role} cannot send campaign messages`);

  const campaign = await deps.db.marketingCampaign.findUnique({ where: { id: input.campaignId } });
  if (!campaign) throw marketingErrors.notFound('Campaign', input.campaignId);
  if (!['APPROVED', 'SCHEDULED', 'PUBLISHED'].includes(campaign.status)) throw marketingErrors.invalidState(`Campaign is ${campaign.status}, not APPROVED`);

  const content = await deps.db.marketingContent.findUnique({ where: { id: input.contentId } });
  if (!content || content.campaignId !== campaign.id) throw marketingErrors.invalidInput('Content does not belong to this campaign');
  if (content.status !== 'APPROVED') throw marketingErrors.invalidState(`Content is ${content.status}, not APPROVED`);
  if ((content.compliance as { verdict?: string } | null)?.verdict === 'BLOCK') throw marketingErrors.invalidState('Content has blocking compliance findings');

  const audience = await deps.db.marketingAudience.findUnique({ where: { id: input.audienceId } });
  if (!audience) throw marketingErrors.notFound('Audience', input.audienceId);
  const expectedType = audience.channel === 'EMAIL' ? 'EMAIL' : audience.channel === 'WHATSAPP' ? 'WHATSAPP_MESSAGE' : null;
  if (!expectedType || content.channel !== audience.channel || content.type !== expectedType) {
    throw marketingErrors.invalidInput(`Content (${content.channel}/${content.type}) does not match the ${audience.channel} audience`);
  }

  const evaluation = await evaluateCampaignSafeguards(
    campaign.productIds,
    campaign.discountPct == null ? null : toNumber(campaign.discountPct),
    deps.safeguards,
    { now: deps.now }
  );
  if (evaluation.verdict === 'BLOCK') throw new CampaignSafeguardError(evaluation, 'campaign message');

  const resolution = await resolveAudience(audience.id, deps.audience);
  const batch = resolution.eligible.slice(0, MAX_RECIPIENTS_PER_CALL);
  const lang = content.language === 'es' ? 'es' : 'en';
  const channel = audience.channel as 'EMAIL' | 'WHATSAPP';
  const body = `${content.body}\n\n—\n${FOOTER[lang][channel]}`;

  let sent = 0;
  let alreadySent = 0;
  let failed = 0;
  for (const r of batch) {
    const key = messageIdempotencyKey(content.id, content.version, r.contactId);
    // The core service replays a prior send's result as-is (sent: true), so a
    // duplicate is indistinguishable from a new send by its return value.
    // Read the core idempotency record first (read-only) to report it
    // honestly and skip the call; the core claim still guards any race.
    if (await deps.db.idempotencyKey.findUnique({ where: { key }, select: { key: true } })) {
      alreadySent += 1;
      continue;
    }
    const res = await deps.send(
      {
        channel: channel === 'EMAIL' ? 'email' : 'whatsapp',
        to: r.address,
        subject: channel === 'EMAIL' ? content.title ?? campaign.name : null,
        body,
        templateKey: `marketing:${campaign.id}:${content.id}`,
        companyId: r.companyId,
        contactId: r.contactId,
        userId: actor.userId,
        idempotencyKey: key,
      },
      deps.senderDeps
    );
    if (res.reason?.startsWith('Already sent') || res.reason === 'A send with this key is already in progress') alreadySent += 1;
    else if (res.sent) sent += 1;
    else failed += 1;
  }

  const result: CampaignMessageResult = {
    matched: resolution.matched,
    eligible: resolution.eligible.length,
    attempted: batch.length,
    sent,
    alreadySent,
    failed,
    remaining: Math.max(0, resolution.eligible.length - batch.length),
    excluded: resolution.excluded,
  };

  await deps.db.campaignApproval.create({
    data: {
      campaignId: campaign.id,
      targetType: 'CONTENT',
      targetId: content.id,
      fromStatus: 'APPROVED',
      toStatus: 'PUBLISHED',
      decidedById: actor.userId,
      comment: `${channel} send to audience ${audience.id}: ${sent} sent, ${alreadySent} already sent, ${failed} failed, ${result.remaining} remaining`,
      safeguardVerdict: evaluation.verdict,
      safeguardSnapshot: JSON.parse(JSON.stringify(evaluation)) as Prisma.InputJsonValue,
    },
  });
  return result;
}
