import { prisma } from '@/lib/prisma';
import type { Prisma, CommunicationType, CommunicationDirection, RelatedEntityType } from '@prisma/client';

type Db = typeof prisma | Prisma.TransactionClient;

export interface RecordCommunicationInput {
  type: CommunicationType;
  direction?: CommunicationDirection;
  subject?: string | null;
  body?: string | null;
  recipient?: string | null;
  templateKey?: string | null;
  status: 'SENT' | 'FAILED';
  companyId?: string | null;
  contactId?: string | null;
  relatedType?: RelatedEntityType | null;
  relatedId?: string | null;
  userId?: string | null;
}

/**
 * The single write path for every outbound-communication audit entry
 * (Phase 10, docs/CUSTOMER_COMMUNICATION.md) — both the manual
 * template-driven send flow (src/lib/communications/send.ts) and the
 * pre-existing automated notification senders (payment reminders, order
 * confirmations, invoice delivery, WhatsApp sends) funnel through this one
 * function, so "every outbound communication is logged" has exactly one
 * place it could fail to be true, not several.
 */
export async function recordCommunication(input: RecordCommunicationInput, db: Db = prisma) {
  return db.communicationLog.create({
    data: {
      type: input.type,
      direction: input.direction ?? 'OUTBOUND',
      subject: input.subject ?? null,
      body: input.body ?? null,
      recipient: input.recipient ?? null,
      templateKey: input.templateKey ?? null,
      status: input.status,
      companyId: input.companyId ?? null,
      contactId: input.contactId ?? null,
      relatedType: input.relatedType ?? null,
      relatedId: input.relatedId ?? null,
      userId: input.userId ?? null,
    },
  });
}
