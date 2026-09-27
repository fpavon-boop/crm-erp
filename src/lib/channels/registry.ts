import type { ChannelDescriptor } from './types';

/** Static registry of every channel the abstraction knows the *name* of.
 * This is metadata only — it does not import or call any of the
 * per-channel stub modules, and none of them are wired into any sync path.
 * See docs/SALES_CHANNEL_ARCHITECTURE.md for what "active" vs "planned"
 * means here. */
export const CHANNEL_REGISTRY: readonly ChannelDescriptor[] = [
  {
    channel: 'WOOCOMMERCE',
    label: 'WooCommerce',
    status: 'active',
    implementationNote:
      'Real, live sync: src/lib/wordpress/woocommerce.ts. Unaffected by this abstraction — ' +
      'it still uses its own externalSource/externalId columns, not ChannelReference.',
  },
  {
    channel: 'AMAZON',
    label: 'Amazon',
    status: 'planned',
    implementationNote: 'No integration exists. src/lib/channels/amazon.ts is a stub only.',
  },
  {
    channel: 'WALMART',
    label: 'Walmart',
    status: 'planned',
    implementationNote: 'No integration exists. src/lib/channels/walmart.ts is a stub only.',
  },
  {
    channel: 'TIKTOK_SHOP',
    label: 'TikTok Shop',
    status: 'planned',
    implementationNote: 'No integration exists. src/lib/channels/tiktok-shop.ts is a stub only.',
  },
];
