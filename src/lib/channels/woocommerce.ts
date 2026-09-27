/**
 * WooCommerce is the one channel with a real, live integration — but it
 * lives entirely in src/lib/wordpress/woocommerce.ts and client.ts, using
 * the pre-existing externalSource/externalId columns on Company/Product/
 * ProductVariant/SalesOrder/Payment. This file intentionally does nothing
 * but point there: it does not wrap, call, or re-export that sync logic,
 * so the channel abstraction cannot change WooCommerce's behavior.
 */
export const WOOCOMMERCE_IMPLEMENTATION_PATH = 'src/lib/wordpress/woocommerce.ts';
