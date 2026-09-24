# Product Cost & Profitability Reporting

**Date:** 2026-09-24 (Phase 6)
**Status:** Implemented and tested. This document is the explicit behavior —
code should match this, not the other way around.

## What this is (and isn't)

This phase adds profitability reporting — Revenue, COGS, Gross Profit, and
Gross Margin % — at five levels (Product, Sales Order, Invoice, Customer,
Monthly), built entirely from existing data (`Product.cost`,
`PurchaseOrderItem.unitCost` + `GoodsReceiptItem`, `SalesOrder`/
`SalesOrderItem`, `Invoice`/`InvoiceItem`, `Company`). No schema changes.

Only **Website/WooCommerce and direct sales** are in scope. Amazon and
Walmart are not represented anywhere in this schema (no channel field exists
for them), so there was nothing to exclude in code — this document records
that exclusion as a deliberate scope boundary, not an oversight.

## Accounting assumptions & COGS attribution logic

### Revenue

Per line, revenue is `quantity * unitPrice - discount` — the same per-line
math `src/lib/totals.ts` already uses to build an order/invoice's own
`subtotal`/`discountTotal`, so a line's profitability revenue always
reconciles with that document's own stored totals. **Sales tax is never
part of revenue** — it's collected on behalf of a tax authority, not
earned, and is excluded the same way `computeTotals()` keeps `taxTotal`
separate from `subtotal`.

A "Shipping" line (see `docs/WOOCOMMERCE_INTEGRATION.md` — WooCommerce
orders with a shipping charge get one, carrying no `productId`) is real
revenue and is included in every Revenue figure, exactly like any other
order line.

### COGS — cost attribution priority

There is no per-order "what did this unit actually cost us" field anywhere
in this schema. `getProductCostMap()` (`src/lib/profitability.ts`) resolves
one unit cost per **Product** (not per `ProductVariant` — see "Variant cost
vs standard cost" below), in this strict priority order:

1. **Purchase history** — a quantity-weighted average of
   `PurchaseOrderItem.unitCost` across every `GoodsReceiptItem` actually
   received for that product:
   `Σ(receivedQty × unitCost) / Σ(receivedQty)`.
   This is the strongest signal available: it's what the business actually
   paid, not an estimate, and a weighted average (rather than "most recent
   receipt" or "first receipt") is resistant to one unusually cheap or
   expensive shipment skewing the figure.
2. **Standard cost** — `Product.cost`, used only when it is **greater than
   zero**.
3. **Unknown** — neither source has a usable value.

### Why `Product.cost == 0` is never treated as a real cost

`Product.cost` defaults to `0` for every product in this schema (Prisma
`@default(0)`) — there is no separate flag distinguishing "someone
deliberately priced this at $0 cost" from "no one has ever set this field."
Treating every untouched `0` as a real cost would silently under-report
COGS (and over-report gross profit) for any product that has never been
priced or ever purchased through a PO — exactly the "invent cost values...
silently assuming zero" this phase's rules explicitly forbid. So: a `0`
standard cost with no purchase history resolves to **unknown**, never to a
`$0` COGS. (A product that a purchase-history receipt genuinely recorded at
`$0` unit cost — e.g. a free promotional sample — **does** resolve to a
real `$0` COGS from the purchase-history path, since that `0` came from an
actual recorded transaction, not an unset default.)

### Variant cost vs. standard cost

`ProductVariant` has no cost field of its own in this schema — only
`Product.cost` exists at the product level. `PurchaseOrderItem` and
`GoodsReceiptItem` can reference a `productVariantId`, but in practice
(see `docs/WOOCOMMERCE_INTEGRATION.md`, every synced product has at most
one variant — a "Default" one) cost is not meaningfully distinguishable
per-variant today. This phase attributes cost at the **Product** level
only — every line referencing a `productId` (regardless of which variant)
draws from the same per-product cost map. If per-variant costing is ever
needed, it would require a schema change (a `ProductVariant.cost` column or
a `productVariantId`-keyed weighted average) — out of scope here, since
this phase makes no schema changes.

### A line with no product (e.g. Shipping)

A line with no `productId` — currently only the "Shipping" line WooCommerce
sync creates — has **no COGS question to answer**: it contributes `0` to
COGS (a known, real zero — the business doesn't buy shipping charges as
inventory), not `null`/unknown. This is a deliberate distinction from an
actual product whose cost genuinely couldn't be resolved: see
`costSource: 'not_applicable'` vs `'unknown'` in `LineProfitability`. A
non-product line must never make an otherwise fully-known aggregate look
incomplete.

## How unknown/missing costs are reported and handled

**Unknown cost is never coerced to zero, anywhere in this module.**
`computeLineProfitability()` returns `cogs: null` for a real product with
no resolvable cost. `summarizeProfitability()` propagates that: the moment
any line in a group has `cogs: null`, the group's own `cogs`,
`grossProfit`, and `grossMarginPercent` are **all** `null` — because the
group's *true* total COGS is not a smaller, computable number in that
case, it's an unknown one, and reporting `knownCogs` alone as `cogs` would
silently understate it.

To keep the report useful even when incomplete, every summary also carries:

| Field | Meaning |
|---|---|
| `knownCogs` | Sum of COGS across only the lines that *did* resolve a cost (always computable). |
| `partialGrossProfit` | `revenue - knownCogs` — an "at least this much profit" floor, always computable. |
| `hasUnknownCost` | `true` if any line's cost is unknown. |
| `unknownCostRevenue` | How much revenue is tied to unknown-cost lines. |
| `unknownCostLineCount` | How many lines. |

The `/finance/profitability` dashboard surfaces this directly: whenever
`hasUnknownCost` is true anywhere in the overall total, an amber banner
states exactly how many lines and how much revenue are affected, and every
COGS/Gross-profit figure on the page is rendered as `"$X+"` (a floor) with
a "partial" label instead of a clean final number — never silently shown
as if it were complete.

## Fee inclusion rules

The task asks this phase to account for shipping cost, Stripe processing
fees, and WooCommerce platform fees "where reliable data exists." None of
the three has reliable, per-order data in this schema today:

| Fee | Why it's excluded |
|---|---|
| **Shipping cost** | The "Shipping" order line (see above) is what the *customer* was charged for shipping — real revenue. What the business actually *paid a carrier* per order is not recorded anywhere (`Expense` has a "Shipping / Freight" category, but `Expense` rows aren't linked to individual orders — see `src/lib/finance.ts`). There is no reliable per-order shipping cost to subtract, so none is invented. |
| **Stripe processing fees** | `docs/STRIPE_INTEGRATION.md`'s `Payment` model records `amount`, `stripePaymentIntentId`, `stripeChargeId` — never Stripe's own fee (that lives on Stripe's `balance_transaction` object, which this integration never fetches or stores). No fee field exists to read. |
| **WooCommerce platform fees** | WooCommerce doesn't charge a platform fee on self-hosted stores the way a marketplace (Amazon/Walmart — explicitly out of scope for this phase) does, and no such field exists in `docs/WOOCOMMERCE_INTEGRATION.md`'s sync. |

Because none of these three has a reliable source, **Gross Profit here is
Revenue − COGS only** — no fee deduction is applied or estimated anywhere
in this phase. This is stated plainly on the dashboard page itself (the
footer note) and here, rather than silently treating "no data" as "no
fees" without saying so. If any of these three becomes trackable in the
future (e.g. a schema addition to store Stripe's actual fee per Payment),
it should be added as its own explicit, separately-reported figure — not
folded into COGS, which is reserved for product cost specifically.

## The five profitability levels

All five reuse the same two core functions — `computeLineProfitability()`
(one order/invoice line in, one `{revenue, cogs, unitCost, costSource}`
out) and `summarizeProfitability()` (a list of those, reduced to one
`ProfitabilitySummary`) — so there is exactly one place margin math can be
wrong, not five.

1. **Product** — `getProductProfitability()`: every stock-holding sales
   order line (see "Revenue recognition" below), grouped by `productId`.
2. **Sales Order** — `getSalesOrderProfitability()`: grouped by order,
   including any non-product (shipping) lines.
3. **Invoice** — `getInvoiceProfitability()`: a **deliberately separate**
   query against `Invoice`/`InvoiceItem` (type `INVOICE`, actually-issued
   statuses only — `SENT`/`PARTIAL`/`PAID`/`OVERDUE`, matching
   `docs/ACCOUNTS_RECEIVABLE.md`'s own status handling). An invoice can be
   edited or diverge from the sales order it was generated from, so "what
   did we bill" and "what did we sell" are genuinely different questions
   here — the same reasoning `docs/ACCOUNTS_RECEIVABLE.md` gives for
   keeping its AR module separate from `src/lib/finance.ts`.
4. **Customer/Company** — `getCustomerProfitability()`: sales-order lines
   grouped by `companyId`. Orders with no company on file (e.g. a
   WooCommerce guest checkout resolved only to a `Contact` — see
   `docs/WOOCOMMERCE_INTEGRATION.md`) are grouped under a single
   **"No customer assigned"** bucket rather than dropped, since that
   revenue is real.
5. **Monthly** — `getMonthlyProfitability()`: sales-order lines grouped by
   the order's `createdAt` month, sorted chronologically for trend
   reading.

Product, Sales Order, Customer, and Monthly are all derived from **one
shared query** (`fetchScoredOrderLines()`, reused directly by
`getProfitabilityDashboard()`) — one read, four ways of looking at it — so
those four views can never disagree with each other about total revenue,
the same "no duplicate financial data" discipline `docs/CUSTOMER_360.md`
and `docs/ACCOUNTS_RECEIVABLE.md` already apply. Invoice-level is
intentionally the one exception, for the reason given above.

### Revenue recognition (which orders/invoices count)

- **Sales orders**: only `CONFIRMED`, `SHIPPED`, or `DELIVERED` — the exact
  same "actually sold" set `src/lib/finance.ts` already uses for its
  "Orders sold" figure (`STOCK_HOLDING_STATUSES` from
  `src/lib/automations/stock.ts`). `DRAFT` was never sold; `CANCELLED` was
  reversed.
- **Invoices**: `type: INVOICE` and status `SENT`/`PARTIAL`/`PAID`/
  `OVERDUE` — actually issued. `DRAFT` (never sent) and `CANCELLED`
  (voided) are excluded, and `ESTIMATE`/`RECEIPT` document types are never
  receivables or sales to begin with.

## Edge cases

- **Zero revenue** — `grossMarginPercent` is `null` (mathematically
  undefined — there is nothing to divide by), never `0%` and never
  `±Infinity%`. The dashboard renders this as `"n/a (no revenue)"`.
- **100% margin** — a line/group with `cogs === 0` (a real, known zero —
  see above) and positive revenue reports exactly `100`.
- **Negative margin (a loss)** — when COGS exceeds revenue, `grossProfit`
  is negative and `grossMarginPercent` is a negative number, reported as
  computed — a loss is real information, never clamped to zero.
- **Unknown cost** — see "How unknown/missing costs are reported and
  handled" above.

## Authorization

The dashboard (`/finance/profitability`) is gated the same way as
`/finance` and `/finance/receivables`: `requireModule('finance')`
(`src/lib/session.ts`), restricted in `src/lib/permissions.ts`'s `MATRIX`
to `ADMIN` and `ACCOUNTING`. The task's phrasing — "visible to
Admin/Accounting/Management" — maps onto this app's actual `Role` enum
(`ADMIN`, `SALES`, `OPERATIONS`, `ACCOUNTING`; there is no separate
"Management" role) the same way `docs/ACCOUNTS_RECEIVABLE.md` mapped
"Accounting/Admin access" onto the same existing `finance` module, rather
than inventing a new permission scheme.

## Testing

- `tests/profitability-calculations.test.ts` — pure-function tests, no
  database: line-level revenue/COGS math, non-product lines never counting
  as unknown cost, aggregate summarization, and every edge case above
  (zero revenue, 100% margin, negative margin, one-unknown-cost-line
  poisoning an otherwise-known aggregate, `knownCogs`/`partialGrossProfit`
  staying computable regardless).
- `tests/profitability-authorization.test.ts` — database-backed:
  `getProductCostMap()`'s three-tier priority against real
  `GoodsReceiptItem`/`PurchaseOrderItem`/`Product` rows (including that a
  `$0` standard cost with no purchase history resolves to unknown, not
  zero, even when a *different*, non-zero standard cost is set on the same
  product to prove history still wins), each of the five levels against
  real seeded orders/invoices (including DRAFT/CANCELLED/ESTIMATE
  exclusion), date-range filtering, dashboard/breakdown revenue
  reconciliation, and the `finance`-module role gate.

## Known limitations

- **No per-order shipping cost, Stripe fee, or WooCommerce platform fee** —
  see "Fee inclusion rules." Gross Profit is Revenue − COGS (product cost)
  only.
- **Cost is attributed at the Product level, not per `ProductVariant`** —
  see "Variant cost vs. standard cost."
- **No Amazon/Walmart channel support** — out of scope per this phase's
  rules, and nothing in the schema represents those channels regardless.
- **Purchase-history weighted average never expires** — a cost from a
  receipt three years ago weighs the same as one from yesterday. A
  time-decayed or "most recent N receipts" average would be a reasonable
  future refinement but isn't implemented here.
