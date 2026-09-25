# WooCommerce Integration

**Date:** 2026-09-23 (Phase 2 hardening)
**Status:** Implemented and tested. This document is the explicit
behavior — code should match this, not the other way around.

## Synchronization direction and source of truth

Sync is **one-way, pull-only, WooCommerce → CRM**, triggered manually
(`POST /api/wordpress/sites/[id]/sync-woocommerce`, the "Sync WooCommerce"
button). There is no push from the CRM back to WooCommerce, and no
webhooks are registered or listened for — see "Future webhook
architecture" below.

WooCommerce is the source of truth for:
- Customer identity and billing details for WooCommerce-originated orders.
- Product catalog data (name, price, description) and stock quantity for
  products it manages.

The CRM is the source of truth for everything that happens to a synced
record *after* import: sales-order status progression, inventory effects
from CRM-side confirm/ship/cancel actions, invoicing, and any CRM-only
edits. Sync never overwrites those.

## Customer mapping

WooCommerce "customers" (registered accounts) and guest checkouts both
become a CRM `Contact`, matched — in this priority order — so the same
real person never gets two Contact rows regardless of which path created
them first:

1. **`(externalSource, externalId)` = `("woocommerce", "<Woo customer id>")`**
   — for a synced WooCommerce customer account.
2. **Email**, case-insensitively — this is what lets a guest order for the
   same email as an already-synced customer (or an existing CRM contact)
   attach to the existing Contact instead of creating a duplicate. A guest
   checkout with no matching Contact creates one with
   `externalId: "guest:<email>"`.

A `Company` is created/linked the same way when the order's billing
carries a company name, matched by `(externalSource, externalId)` for
synced customers or by case-insensitive name for guest orders.

**Concurrency note:** `Contact.email` has no database-level uniqueness
(only `(externalSource, externalId)` does), so the guest-contact path is a
check-then-create rather than a single atomic upsert; it's wrapped in a
transaction that re-checks immediately before creating, narrowing (not
eliminating) the window. The realistic source of that race — two syncs of
the same site overlapping — is closed by the in-flight guard below.

## Product and ProductVariant mapping

Every synced Product and ProductVariant now carries `externalSource` /
`externalId` (added in this hardening pass — previously only Company,
Contact, and SalesOrder had this). Matching priority:

1. **`(externalSource, externalId)` = `("woocommerce", "<Woo product id>")`**
   — the primary, stable key. A product keeps its CRM identity even if its
   SKU is renamed in WooCommerce afterward (the CRM row is updated, not
   duplicated).
2. **SKU** — used to *adopt* an existing CRM-native product that already
   has the same SKU (e.g. one entered manually before this product was
   ever synced) rather than creating a duplicate, and as the required
   mapping key for order line items (see below).

If a WooCommerce product's SKU changes to one already claimed by a
*different* CRM product, the rename is not applied — a warning is
recorded (see "Errors" below) and the existing CRM SKU is left alone,
rather than silently overwriting a different product's SKU.

Each simple WooCommerce product maps to one CRM Product and one "Default"
ProductVariant (also carrying the same external id, since simple products
have no separate variation id). See "Known limitations" for what this
does not cover.

## Order mapping

Orders match on `(externalSource, externalId) = ("woocommerce", "<Woo order id>")`,
so **re-syncing the same order never creates a second SalesOrder** — the
existing row is updated instead (status and financial fields only; see
below for why items are the exception).

**Line items are only set at creation, never replaced on update.** A
WooCommerce order that's already been imported may since have been
confirmed/shipped/cancelled in the CRM (with its own inventory effects —
see `docs/INVENTORY_RULES.md`) or manually edited; blindly replacing its
items on every re-sync would silently bypass all of that reconciliation
logic. Re-running a sync only picks up item changes for an order not yet
imported.

### SKU mapping for order line items

Each line item is resolved to a Product/ProductVariant in this order:

1. The line's own `sku`, matched against `ProductVariant.sku` first, then
   `Product.sku`. **This is the primary mapping key**, per the WooCommerce
   line item's own SKU — which is always the *product's* configured SKU,
   never the CRM's derived `<sku>-default` variant SKU, so a Product match
   here also looks up that product's variant separately.
2. Falls back to the line's `product_id` / `variation_id` against the
   external-id columns above, for the (expected to be rare) case where the
   SKU on the line doesn't match anything.

**An unmatched SKU never drops the line.** The SalesOrderItem is still
created, with its description/quantity/price intact and no product link,
and a warning is generated (see "Errors").

## Financial field mapping

| SalesOrder column | Source |
|---|---|
| `subtotal` | Sum of each line item's own `subtotal` (WooCommerce's pre-discount line total) — summed directly rather than derived by subtracting tax/shipping/discount from the order grand total, which would compound rounding error across several subtractions. |
| `taxTotal` | Order's `total_tax`. |
| `discountTotal` | Order's `discount_total`. |
| `total` | Order's `total`, verbatim. |

**Shipping** has no dedicated SalesOrder column. Rather than fold it
silently into `subtotal` or `total` where it would no longer be visible as
its own figure, a non-zero `shipping_total` is added as its own
SalesOrderItem line (`description: "Shipping"`, quantity 1, unit price =
shipping total) — visible on the order like any other line, not discarded
and not hidden.

## Payment and refund reconciliation (Phase 11)

An order synced while WooCommerce's own status is `processing` or
`completed` automatically gets an `Invoice` (created if none exists yet,
reusing one if it does) and a `Payment` for its full total — Finance's
"received" figure now reflects money WooCommerce orders actually brought
in, not just what they were worth. An order later reported as `refunded`
reverses that payment (`Payment.refundedAmount`, the invoice's
`amountPaid`/status) instead of being folded into the same `CANCELLED`
bucket as a plain cancellation. Both are idempotent across repeated syncs
via `Payment`'s own `(externalSource, externalId)` uniqueness, the same
pattern as every other synced model here. Full detail:
`docs/FINANCIAL_ACCURACY_AND_AUTOMATION.md`.

## Inventory behavior

WooCommerce reports an **absolute** stock quantity per product it manages
stock for (`stock_quantity`). Previously this was written directly to
`StockLevel.quantity` with no `StockMovement` row at all — a genuinely
*silent* overwrite with no audit trail. It's now applied as the **delta**
between the current on-hand quantity and what WooCommerce reports, posted
through the same `recordStockMovement()` every other inventory-affecting
path in the app uses (Phase 1): an `IN` if the delta is positive, an `OUT`
if negative, `referenceType: "WOOCOMMERCE_SYNC"`. A zero delta (nothing
changed since the last sync) posts nothing. This means:

- Every WooCommerce-driven stock change is now visible in the same
  `StockMovement` ledger as sales-order deductions, goods receipts, and
  manual adjustments.
- It can never drive `StockLevel` negative (inherited from Phase 1's
  atomic floor-at-zero update).
- It is idempotent by construction: re-syncing the same reported quantity
  twice posts a movement only the first time.

**This does not change who owns inventory for a WooCommerce-tracked SKU.**
WooCommerce remains the reporting source for its own products; nothing
here pushes CRM-side stock changes (e.g. a CRM-only sale) back to
WooCommerce, so the two systems can still diverge if the CRM is ever used
to sell a WooCommerce-tracked SKU directly — this is a pre-existing,
documented limitation (`docs/SYSTEM_AUDIT.md`, section J), not something
this pass resolves.

## Errors and their visibility

Previously, nearly every step of the sync (`.catch(() => null)` /
`.catch(() => [])`) swallowed errors silently, and per-item counters
(`orders += 1`, etc.) incremented **unconditionally**, so a failed
customer/product/order sync was invisible and the returned counts could
overstate what actually succeeded.

Now:
- Fetching each of customers/products/orders from the WooCommerce API is
  individually try/caught; a failure there is recorded as a warning and
  that phase simply processes zero items, rather than aborting the whole
  sync.
- Every individual customer/product/order upsert is try/caught; on
  failure, a warning is recorded and its counter is **not** incremented —
  the returned counts reflect what actually succeeded.
- Every warning (fetch failures, per-item failures, unknown-SKU lines, SKU
  conflicts) is both returned in the sync's `warnings: string[]` result
  (surfaced today in the WordPress settings page's sync result message)
  **and** written to `AutomationLog` (`entityType: "WOOCOMMERCE_SYNC"`),
  the same table already used for other automation failures — so a
  problem is visible even to someone who didn't watch the sync button's
  response.

Nothing in a warning message or log entry ever includes the WooCommerce
consumer key/secret or a full request URL — see "Authentication" below
for why a URL could otherwise carry the secret.

## Authentication

Requests use HTTP Basic Auth (consumer key/secret as username/password, in
the `Authorization` header) for HTTPS stores — WooCommerce's own
documented, recommended method for HTTPS. Previously, every request sent
the key and secret as **URL query-string parameters**, unconditionally,
including on HTTPS requests: query strings can end up in web-server access
logs, reverse-proxy logs, and browser history, which a header does not.
The query-string method is kept only as an explicit fallback for a
non-HTTPS `baseUrl` (WooCommerce's REST API doesn't support Basic Auth
credibly over plain HTTP anyway); every real site here is expected to be
HTTPS (Easypanel enforces it — `docs/SYSTEM_AUDIT.md`, section A).

Consumer key/secret are read from `WOOCOMMERCE_CONSUMER_KEY` /
`WOOCOMMERCE_CONSUMER_SECRET` environment variables (shared across all
`WordPressSite` rows — there is currently only one active WooCommerce
site, so this is not a limitation in practice today).

## Retry behavior

There is no automatic retry. A sync is triggered manually and runs once;
if the WooCommerce API is unreachable or returns errors, that's recorded
as a warning (see "Errors") and the next manual sync attempt picks up
from current state — every write here is either a genuine upsert
(customers, products, orders — safe to repeat) or an idempotent delta
(inventory — safe to repeat), so re-running a sync after a partial failure
is always safe.

## Concurrency: duplicate-sync prevention

Two syncs of the *same* site running at once (`docs/SYSTEM_AUDIT.md` E4)
would race on the same customer/product/order upserts and on the
guest-contact-by-email check. This is now prevented by an **in-process**
guard (a module-level set of site ids currently syncing) — a second sync
request for a site already syncing is rejected immediately with a clear
error, rather than racing.

This is deliberately not a database-level (Postgres advisory) lock: this
app runs as a single Node process/container (`docs/SYSTEM_AUDIT.md`,
section A), so an in-process guard closes the realistic race without the
correctness risk a *session-level* advisory lock would carry under
Prisma's connection pooling (no guarantee its lock and unlock calls land
on the same underlying connection), and without holding a database
transaction open across the many slow external HTTP calls a full sync
makes to WooCommerce.

## Known limitations

- **WooCommerce variable products (variations) are not specifically
  supported.** Each WooCommerce product — simple or variable — maps to
  exactly one CRM Product and one "Default" ProductVariant. A variable
  product's individual variations (their own SKUs, prices, and stock) are
  not fetched from WooCommerce's separate `/products/{id}/variations`
  endpoint and are not represented in the CRM. If variable products are
  ever sold through this store, this is the first thing to extend.
- **No webhooks yet** — see below.
- Product `description` HTML is stripped to plain text with a simple tag
  regex, not a real HTML sanitizer/parser — adequate for storing a plain
  description, not for anything that needs to preserve formatting.
- The WooCommerce↔CRM inventory divergence risk noted above (CRM-side
  sales of WooCommerce-tracked SKUs) is unchanged by this pass.

## Future webhook architecture (not implemented)

Sync today is pull-only and manual. A push-based webhook flow would let
WooCommerce notify the CRM of changes (order created/updated, product
stock changed) instead of waiting for the next manual sync. If built
later, it should:

- Register WooCommerce webhooks (`order.created`, `order.updated`,
  `product.updated`, at minimum) pointing at a new, signature-verified CRM
  endpoint — following the same HMAC/shared-secret verification pattern
  already used for the WhatsApp and WordPress-leads webhooks
  (`docs/SYSTEM_AUDIT.md` notes this pattern is sound and has no timing
  side-channel).
- Reuse the exact matching/idempotency logic documented above (external-id
  upserts, SKU-based line mapping, the delta-based inventory application)
  — a webhook delivering the same event twice (Woo's own retry behavior on
  a non-2xx response) must be exactly as idempotent as a manual re-sync is
  today.
- Feed failures into the same `AutomationLog`-based visibility path, and
  almost certainly needs its own delivery-tracking (to detect a webhook
  that Woo gave up retrying) rather than relying on the CRM ever finding
  out on its own.

**No webhook endpoints exist yet and none should be registered against the
live WooCommerce store without a deliberate, separate task** — this pass
explicitly did not activate any new production webhooks, per instruction.
