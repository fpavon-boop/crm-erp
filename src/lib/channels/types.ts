import type { SalesChannel, RelatedEntityType } from '@prisma/client';

/** One channel's external identifiers for a single internal record. Only
 * the fields relevant to that record's type are ever populated — an order
 * mapping sets `externalOrderId`/`externalCustomerId`, a product mapping
 * sets `externalProductId`/`externalSku`. */
export interface ChannelReferenceInput {
  channel: SalesChannel;
  entityType: RelatedEntityType;
  entityId: string;
  externalOrderId?: string | null;
  externalCustomerId?: string | null;
  externalProductId?: string | null;
  externalSku?: string | null;
}

export type ChannelStatus = 'active' | 'planned';

/** Static metadata for a channel — not a live connector. No method here
 * calls an external API, reads credentials, or imports data; that's
 * intentionally out of scope until a channel is actually built out (see
 * docs/SALES_CHANNEL_ARCHITECTURE.md). */
export interface ChannelDescriptor {
  channel: SalesChannel;
  label: string;
  status: ChannelStatus;
  /** Where the real integration lives today, for WOOCOMMERCE only. */
  implementationNote: string;
}
