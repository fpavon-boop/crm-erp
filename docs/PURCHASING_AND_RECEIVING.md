# Purchasing & Receiving

**Date:** 2026-09-25 (Phase 7)
**Status:** Implemented and tested. This document is the explicit behavior —
code should match this, not the other way around.

## What this is (and isn't)

This phase solidifies the existing purchasing flow — Supplier, Purchase
Order, Goods Receiving, Supplier Invoice, Payment — by adding the pieces
that were missing to actually **enforce** its lifecycle, rather than
redesigning any of it. Before this phase:

- A purchase order could be created, but there was no way to move it out of
  `DRAFT` short of receiving goods against it directly — nothing enforced
  that an order be approved/sent to the supplier first.
- Nothing prevented receiving goods against a still-`DRAFT` (never
  approved) or `CANCELLED` order.
- Nothing let a purchase order be cancelled at all.
- A duplicate goods-receipt submission (double-click, network retry) that
  happened to stay within the ordered quantity would silently create a
  second `GoodsReceipt` and double-increment inventory — the existing
  over-receiving guard only catches a duplicate when it would exceed the
  ordered total, not when there happens to be enough headroom for it to
  slip through as if it were a second legitimate delivery.

Everything else — the `Company` (supplier) model, `PurchaseOrder`/
`PurchaseOrderItem`, `GoodsReceipt`/`GoodsReceiptItem`, `SupplierInvoice`/
`SupplierPayment`, and the Phase 1 over-receiving guard — is unchanged in
shape and behavior; this phase only closes the three gaps above and makes
existing data (SKU, quantities) more visible in the UI.

## Status mapping (adapting to the existing enum)

The task's requested lifecycle is:

```
Purchase Order -> Approved -> Ordered -> Partially Received -> Received -> Supplier Invoice -> Payment
```

The actual `PurchaseOrderStatus` enum in this schema is:

```prisma
enum PurchaseOrderStatus {
  DRAFT
  SENT
  PARTIALLY_RECEIVED
  RECEIVED
  CANCELLED
}
```

Per the explicit instruction to adapt to existing enums "without inventing
conflicting duplicates," no new status values were added. The mapping:

| Requested stage | Existing status / model |
|---|---|
| Purchase Order (created) | `DRAFT` |
| Approved | `SENT` |
| Ordered | `SENT` |
| Partially Received | `PARTIALLY_RECEIVED` |
| Received | `RECEIVED` |
| Supplier Invoice | `SupplierInvoice` (separate model, own `SupplierInvoiceStatus`) |
| Payment | `SupplierPayment` (child of `SupplierInvoice`) |
| *(cancellation, not in the requested list but required by any real workflow)* | `CANCELLED` |

**"Approved" and "Ordered" collapse onto one status, `SENT`.** This schema
has no separate internal "approved but not yet placed with the supplier"
checkpoint — sending the order *is* the approval-and-placement act in this
system. Adding a distinct `APPROVED` status distinct from `SENT` would be
exactly the "conflicting duplicate" the task said not to invent (two
statuses meaning almost the same thing, with no code able to tell them
apart). If a genuine multi-step internal approval workflow (e.g. a manager
sign-off before an order is allowed to be sent) is wanted later, that's a
new capability, not a gap in adapting the existing one.

## Lifecycle and enforced transitions

```
                 approvePurchaseOrder()          receiveGoodsForPurchaseOrder()
DRAFT ────────────────────────────────► SENT ───────────────────────────────► PARTIALLY_RECEIVED ──► RECEIVED
  │                                       │                                                              │
  │           cancelPurchaseOrder()       │ cancelPurchaseOrder()                                        │
  └───────────────────────────────────────┴──────────────────► CANCELLED                                 │
                                                       (only before anything has been received)           │
                                                                                                            │
                                                    SupplierInvoice.create() ──► SupplierPayment.create() ─┘
                                                    (not gated on PO status — see "Invoicing and payment timing")
```

Implemented in `src/lib/purchase-orders.ts`:

- **`approvePurchaseOrder(id)`** — `DRAFT -> SENT` only. Any other current
  status throws `InvalidPurchaseOrderTransitionError`. This is the new
  "Approved -> Ordered" action; before this phase there was no way to make
  it happen at all.
- **`cancelPurchaseOrder(id)`** — `DRAFT -> CANCELLED` or `SENT ->
  CANCELLED`, and **only** while nothing has been received yet. Guarded
  twice, independently: the order's `status` must be `DRAFT` or `SENT`,
  *and* every item's `quantityReceived` must be `0` — the second check is
  redundant today (receiving always advances status away from `DRAFT`/`SENT`
  the moment anything arrives — see `receiveGoodsForPurchaseOrder`), but it
  means cancellation can never accidentally orphan inventory that's already
  been received, even if some future code path ever created a
  `GoodsReceipt` without going through the normal status update.
- **`receiveGoodsForPurchaseOrder(id, ...)`** — only proceeds while status
  is `SENT` or `PARTIALLY_RECEIVED`. A still-`DRAFT` order was never
  approved or placed; a `CANCELLED` order must never accept goods; a
  `RECEIVED` order has nothing left outstanding (the pre-existing
  over-receipt guard would normally catch this anyway, but the explicit
  status check gives a clearer, more specific error — see "Two different
  rejection reasons" below). Automatically advances the status to
  `PARTIALLY_RECEIVED` or `RECEIVED` as before, unchanged from Phase 1.

### Two different rejection reasons for "can't receive this"

`InvalidPurchaseOrderTransitionError` (wrong lifecycle stage) and
`OverReceiptError` (right stage, wrong quantity) are deliberately distinct:

- Receiving against a `DRAFT`, `CANCELLED`, or already-fully-`RECEIVED`
  order → `InvalidPurchaseOrderTransitionError`. The order simply isn't in
  a receivable state right now.
- Receiving against a `SENT`/`PARTIALLY_RECEIVED` order, but for more than
  the remaining outstanding quantity on one or more lines →
  `OverReceiptError` (unchanged from Phase 1). The order *is* receivable;
  this specific request just asks for too much.

Both tested explicitly in `tests/purchasing-lifecycle.test.ts` and
`tests/inventory-hardening.test.ts`, including the case where a duplicate
submission happens to land on an order that's already fully `RECEIVED`
(rejected by the lifecycle guard) versus one that's still
`PARTIALLY_RECEIVED` (rejected by the over-receipt guard).

### Invoicing and payment timing

Creating a `SupplierInvoice` (with or without a `purchaseOrderId` link) and
recording a `SupplierPayment` against it are **not** gated on the linked
purchase order's status. This is deliberate: in real purchasing, a
supplier's bill commonly arrives before, during, or after the goods
themselves, and forcing "PO must be RECEIVED before its bill can be
recorded" would reject entirely normal bookkeeping (e.g. a prepaid order,
or a bill that arrives ahead of a slow shipment). The requested lifecycle
diagram shows Supplier Invoice and Payment as the natural next steps *after*
Received for the common case, not as a hard database constraint — this
phase documents and preserves that flexibility rather than adding a new
restriction the existing app never had.

## Receiving & inventory integrity

### Partial receiving across multiple events

Unchanged from Phase 1, and directly exercised by
`tests/purchasing-lifecycle.test.ts`'s "partial receiving across multiple
events" test: each call to `receiveGoodsForPurchaseOrder()` creates its own
`GoodsReceipt`, and a purchase order can be received against any number of
times as long as each call's requested quantities fit within what's still
outstanding. `PurchaseOrderItem.quantityReceived` is a running total,
incremented once per receipt — never overwritten.

### Inventory increments only by what was actually received

`applyGoodsReceiptInventoryEffect()` (`src/lib/automations/stock.ts`, from
Phase 1, unchanged) posts exactly one `IN` `StockMovement` per received
line, for exactly the quantity in that `GoodsReceiptItem` — never the
line's full ordered quantity. Confirmed directly: receiving 10 of 30
ordered raises `StockLevel` by 10, not 30; a second receipt of 15 raises it
to 25; a third of 5 completes it at 30 — see
`tests/purchasing-lifecycle.test.ts`.

### Over-receiving guard (Phase 1, unchanged)

Before writing anything, every requested line is checked against `quantity
- quantityReceived` (the outstanding amount) for that specific
`PurchaseOrderItem`. If any line's requested quantity would exceed what's
outstanding, the **entire** request is rejected — nothing is partially
applied — with an `OverReceiptError` naming each violating line, its
requested amount, and what's actually remaining. A genuinely new partial
shipment within the remaining budget is always allowed; only a request
that would push a line past its ordered total is not.

### Idempotency: repeated/duplicate receipt submissions (new in Phase 7)

**The gap this closes:** the over-receiving guard alone is not enough to
protect against a duplicate submission that happens to fit within the
remaining outstanding quantity — e.g. an order for 100, with 50 already
received; a genuine second delivery of 20 and an accidental duplicate
submission of that same 20 look identical to the over-receiving guard, since
20 + 20 = 40 is still under the remaining 50. Without a way to recognize
"this is the same request as before," a double-click or a browser's silent
retry of a dropped connection would create a second `GoodsReceipt` and
double-count 20 real units of inventory that never actually arrived twice.

**The fix:** an optional, caller-supplied `idempotencyKey` on
`GoodsReceipt` (additive migration
`prisma/migrations/20260925010000_goods_receipt_idempotency`, nullable +
unique — the same pattern already used for `Payment.stripePaymentIntentId`
in Phase 4). `receiveGoodsForPurchaseOrder(purchaseOrderId, warehouseId,
items, idempotencyKey?)`:

1. Inside the same `pg_advisory_xact_lock`-guarded transaction the
   over-receiving check already uses (so this is race-free against a
   second concurrent call the same way over-receiving already is), looks
   up an existing `GoodsReceipt` with that key.
2. If found: returns it unchanged (`duplicate: true`) — nothing is
   written, no stock movement, no `quantityReceived` increment, no status
   change beyond what the original call already did.
3. If not found: proceeds exactly as before, and stores the key on the new
   receipt.
4. A `P2002` unique-constraint violation on the create (defense in depth,
   for the unlikely case two callers ever raced outside the advisory lock)
   is caught and translated into the same duplicate-result response rather
   than surfacing a raw database error.

**Omitting the key preserves the exact prior behavior** — no deduplication,
every call is its own receipt — so this is purely additive for any existing
or future caller that doesn't supply one.

**The UI form** (`ReceiveGoodsForm.tsx`) generates one key per logical
"receive goods" submission (via `crypto.randomUUID()`), keeps it in
component state across the request, and only draws a fresh key after a
submission actually succeeds — so retries of the same click reuse the same
key, and a genuinely new receipt (the next time the form is submitted)
always gets a new one.

Tested in `tests/purchasing-lifecycle.test.ts`: identical key twice → one
receipt, inventory incremented once; identical key even when a naive retry
would otherwise be rejected by the over-receipt guard → recognized as a
duplicate instead of erroring; two different keys → two real receipts;
concurrent submissions with the same key → exactly one receipt is ever
created; no key supplied → behaves exactly as before (no dedup).

## Detailed tracking

| Requested field | Where it lives | Notes |
|---|---|---|
| Supplier | `PurchaseOrder.supplier` (`Company`, `type: SUPPLIER`) | Unchanged; shown as the page subtitle and in list views. |
| SKU | `Product.sku`, via `PurchaseOrderItem.productId` | Now shown as its own column on the purchase order detail page and included in the `GET /api/purchase-orders/[id]` response (previously only `description` was shown in the UI). |
| Unit cost | `PurchaseOrderItem.unitCost` | Unchanged. |
| Quantity ordered | `PurchaseOrderItem.quantity` | Unchanged. |
| Quantity received | `PurchaseOrderItem.quantityReceived` | Unchanged — a running total incremented by each receipt. |
| Quantity outstanding | *(derived)* `quantity - quantityReceived` | Never stored — always computed at read time from the two authoritative fields above, so it can never drift from them. Now shown as its own column on both the order detail page and the receive-goods form, and included as `quantityOutstanding` in the `GET /api/purchase-orders/[id]` response. |

### Fields not present in this schema — not invented

**Supplier SKU** (the supplier's own part number, as distinct from this
system's internal `Product.sku`), **Currency**, **Lead time**, **Payment
terms**, **Shipping terms**, and **Incoterms** do not exist anywhere in
this schema today — there is no field on `Company`, `PurchaseOrder`, or
`PurchaseOrderItem` for any of them (the whole application is implicitly
single-currency; `src/lib/format.ts`'s `money()` hard-codes `USD`
formatting throughout). Per "Adapt strictly to existing models... do not
redesign the purchasing architecture," none of these were added as new
columns. Requirement 3 itself scopes the lead-time/payment-terms/
shipping-terms/Incoterms group as "if already present in the schema" —
they are not, so nothing was added for them, consistent with every prior
phase's rule against inventing fields or values that aren't already backed
by real data. If any of these become genuinely needed, that is a schema
change for a future, explicitly-scoped phase — not something to slip in
here.

## Authorization

Unchanged: every purchasing route (`GET`/`POST /api/purchase-orders`,
the new `/approve` and `/cancel` actions, `/receive`,
`/api/supplier-invoices`) is gated by `requireApiModule('purchasing')`
(pages by `requireModule('purchasing')`), per the existing
`src/lib/permissions.ts` matrix — `ADMIN` and `OPERATIONS` have the
`purchasing` module; `SALES` and `ACCOUNTING` do not. `SupplierInvoice`
payments specifically require the `finance` module (`ADMIN`/`ACCOUNTING`),
also unchanged. This phase adds no new module and no new role.

## Testing

- `tests/inventory-hardening.test.ts` (Phase 1, updated) — the existing
  over-receiving coverage, with one assertion updated to reflect that a
  duplicate submission against an *already-fully-RECEIVED* order is now
  caught by the new, more specific lifecycle guard rather than the
  over-receipt guard, plus a new companion test confirming the
  over-receipt guard still fires on its own when the order is genuinely
  still `PARTIALLY_RECEIVED`.
- `tests/purchasing-lifecycle.test.ts` (new, Phase 7) — `approvePurchaseOrder`
  and `cancelPurchaseOrder` across every valid and invalid starting status;
  the receiving-status gate (rejecting `DRAFT`/`CANCELLED`, allowing
  `SENT`); partial receiving across three separate events with
  per-step inventory assertions; and the full idempotency suite described
  above.

## Known limitations

- **No internal multi-step approval workflow** — `SENT` is both "approved"
  and "ordered"; adding a distinct pre-send approval gate (e.g. requiring a
  second user's sign-off) would be a new capability, not something this
  phase's schema supports today.
- **No Supplier SKU, currency, lead time, payment terms, shipping terms, or
  Incoterms tracking** — see "Fields not present in this schema" above.
- **Supplier Invoice / Payment timing is not gated on PO status** — see
  "Invoicing and payment timing" above; this is a deliberate choice, not an
  oversight.
- **Idempotency is opt-in** — a caller that never supplies an
  `idempotencyKey` gets no duplicate protection, exactly as before this
  phase. The shipped UI form always supplies one; any other integration
  that calls `POST /api/purchase-orders/[id]/receive` directly should do
  the same if it needs the guarantee.
