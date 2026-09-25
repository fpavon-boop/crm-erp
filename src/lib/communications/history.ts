import { prisma } from '@/lib/prisma';
import type { RelatedEntityType } from '@prisma/client';

const HISTORY_LIMIT = 50;

/** The communication timeline for one company (every logged email/WhatsApp
 * message tied to it, regardless of which specific record it was about) —
 * used by the Company/Customer 360 page. */
export async function getCompanyCommunicationTimeline(companyId: string) {
  return prisma.communicationLog.findMany({
    where: { companyId },
    include: { user: { select: { name: true } } },
    orderBy: { occurredAt: 'desc' },
    take: HISTORY_LIMIT,
  });
}

/** The communication timeline scoped to one specific business record (a
 * Sales Order, Invoice, Quote, ...) — only entries sent through the
 * template flow with that record explicitly selected, not every message
 * ever sent to the record's company. Used by, e.g., the Sales Order
 * detail page. */
export async function getRelatedCommunicationTimeline(relatedType: RelatedEntityType, relatedId: string) {
  return prisma.communicationLog.findMany({
    where: { relatedType, relatedId },
    include: { user: { select: { name: true } } },
    orderBy: { occurredAt: 'desc' },
    take: HISTORY_LIMIT,
  });
}
