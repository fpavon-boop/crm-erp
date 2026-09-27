import { prisma } from '@/lib/prisma';
import type { ChannelReferenceInput } from './types';
import type { SalesChannel, RelatedEntityType } from '@prisma/client';

/** Create or update the mapping between one internal record and its
 * identifiers on one external channel. Local data access only — no channel
 * connector calls this yet. */
export async function upsertChannelReference(input: ChannelReferenceInput) {
  return prisma.channelReference.upsert({
    where: {
      channel_entityType_entityId: {
        channel: input.channel,
        entityType: input.entityType,
        entityId: input.entityId,
      },
    },
    create: input,
    update: {
      externalOrderId: input.externalOrderId,
      externalCustomerId: input.externalCustomerId,
      externalProductId: input.externalProductId,
      externalSku: input.externalSku,
    },
  });
}

export async function findChannelReference(
  channel: SalesChannel,
  entityType: RelatedEntityType,
  entityId: string
) {
  return prisma.channelReference.findUnique({
    where: { channel_entityType_entityId: { channel, entityType, entityId } },
  });
}
