# Sales Channel Architecture

**Date:** 2026-09-27
**Status:** Schema and stub code only. No channel other than WooCommerce has
a real integration, and WooCommerce's existing integration was not touched.

## What this is

A generic, extensible place for multi-channel sales-integration identifiers
to live, so adding Amazon, Walmart, or TikTok Shop later is a matter of
filling in a connector — not redesigning the data model. This phase adds
**only** the schema and inert stub files; it does not connect any
credentials, call any API, or import any data.

## Why a new table instead of extending the existing WooCommerce fields

Company, Contact, Product, ProductVariant, SalesOrder, and Payment already
have `externalSource: String?` / `externalId: String?` columns (added in
`20260923020000_woocommerce_external_ids`) that the live WooCommerce sync
(`src/lib/wordpress/woocommerce.ts`) reads and writes today. Reusing those
columns for a new abstraction would mean touching the sync code that
currently works — explicitly out of scope here ("Existing WooCommerce
behavior must remain 100% intact").

Instead, `ChannelReference` is a **new, separate** table. WooCommerce's real
data keeps living in its existing columns, untouched. `ChannelReference` is
where a *future* channel (or a future WooCommerce-to-abstraction migration,
if ever decided) would write instead.

## Schema

```prisma
enum SalesChannel {
  WOOCOMMERCE
  AMAZON
  WALMART
  TIKTOK_SHOP
}

model ChannelReference {
  id                 String            @id @default(cuid())
  channel            SalesChannel
  entityType         RelatedEntityType // COMPANY, PRODUCT, SALES_ORDER, etc.
  entityId           String            // the internal record's id
  externalOrderId    String?
  externalCustomerId String?
  externalProductId  String?
  externalSku        String?
  createdAt          DateTime          @default(now())
  updatedAt          DateTime          @updatedAt

  @@unique([channel, entityType, entityId])
  @@index([channel, externalOrderId])
  @@index([channel, externalCustomerId])
  @@index([channel, externalProductId])
  @@index([channel, externalSku])
}
```

One row maps one internal record (`entityType` + `entityId`, reusing the
`RelatedEntityType` enum already used by `Note`/`Document`/audit logging) to
its identifiers on one external channel. Only the fields relevant to that
record's kind are populated — an order mapping sets `externalOrderId`/
`externalCustomerId`; a product mapping sets `externalProductId`/
`externalSku`. The `@@unique([channel, entityType, entityId])` means a
record has at most one mapping per channel, and the four `@@index`es on
`(channel, external*Id)` support the lookup direction a webhook needs:
"I got this external order id from Amazon — which internal `SalesOrder` is
that?"

Migration: `prisma/migrations/20260927111620_add_sales_channel_reference/`
— purely additive (one `CREATE TYPE`, one `CREATE TABLE`, five indexes), no
`ALTER TABLE` on any existing model.

## Code

- `src/lib/channels/types.ts` — `ChannelReferenceInput`, `ChannelDescriptor`.
- `src/lib/channels/reference.ts` — `upsertChannelReference()` /
  `findChannelReference()`, the only code that reads or writes
  `ChannelReference`. Nothing else in the codebase calls these yet.
- `src/lib/channels/registry.ts` — static metadata (`CHANNEL_REGISTRY`)
  listing all four channels and whether each is `'active'` or `'planned'`.
- `src/lib/channels/woocommerce.ts` — not a connector. Just a pointer
  (`WOOCOMMERCE_IMPLEMENTATION_PATH`) at the real, live integration in
  `src/lib/wordpress/woocommerce.ts`, so nobody mistakes this abstraction
  for a second WooCommerce sync path.
- `src/lib/channels/amazon.ts`, `walmart.ts`, `tiktok-shop.ts` — stubs. Each
  exports one `notImplemented()` function that throws. No HTTP calls, no
  `process.env` reads, no imports of any HTTP client or SDK.

## What was deliberately NOT done

- No UI, no API route, no automation-engine hook reads or writes
  `ChannelReference` — it is inert until a real channel integration is
  built against it.
- No changes to `src/lib/wordpress/woocommerce.ts`, `client.ts`, or any
  WooCommerce-related route. Verified by running the existing test suite
  (`tests/*.test.ts` covering WooCommerce sync behavior) unchanged and
  green after this change.
- No Amazon/Walmart/TikTok Shop credentials, SDKs, or API clients were
  added anywhere in the codebase or `package.json`.

## Testing

`tests/channel-reference.test.ts` (3 tests, DB-backed via the same
`startTestDb()` harness every other integration test uses): create-and-find
a mapping, upsert-in-place (no duplicate row) on a second write for the
same `(channel, entityType, entityId)`, and two independent channels
mapping the same internal record without colliding.
