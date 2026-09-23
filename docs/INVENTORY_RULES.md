# Inventory Rules

**Date:** 2026-09-22 (Phase 0 follow-up, updated for Phase 1 hardening)
**Status:** Implemented and tested. This document is the explicit business
rule — code should match this, not the other way around.

## Inventory model: on-hand only, no reservation

`StockLevel` has a single `quantity` field per (product variant, warehouse).
**There is no "available vs. reserved vs. physical" distinction anywhere in
the schema or the code.** A sales order that reaches a stock-consuming
status physically deducts from this one number immediately — there is no
concept of "soft-reserving" stock for a DRAFT or SENT quote/order while
still counting it as available to sell elsewhere.

This document does not introduce one. Per the scope of this hardening pass,
the existing single-quantity model is preserved as-is; only its
reliability, transactionality, and idempotency are hardened. If the
business later needs a true available/reserved split (e.g. to stop selling
stock that's already committed to a confirmed-but-unshipped order), that is
a genuinely new model and a separate, deliberate change — not something to
infer from this pass.

## Inventory states and movements

Two tables are the whole model:

- **`StockLevel`** — current on-hand quantity per (product variant,
  warehouse). Always the *current snapshot*.
- **`StockMovement`** — an append-only ledger of every change: `type`
  (`IN` / `OUT` / `ADJUSTMENT` / `TRANSFER`), `quantity`, `reason`, and an
  optional `(referenceType, referenceId)` pointing at whatever caused it
  (`SALES_ORDER`, `GOODS_RECEIPT`, `MANUAL_ADJUSTMENT`). This ledger is the
  single source of truth for "did this thing already happen" — never a
  status field, never a boolean flag.

Every place that changes inventory goes through one function,
`recordStockMovement()` (`src/lib/automations/stock.ts`), which creates the
ledger row and updates `StockLevel` together. There is no code path that
writes to `StockLevel` outside of it, **except** the WooCommerce product
sync (`src/lib/wordpress/woocommerce.ts`), which does a direct absolute
`upsert` of `quantity` from Woo's reported stock number — by design, not a
"movement" (see "External sync" below).

All three inventory-affecting flows in the app funnel through
`recordStockMovement()`:

1. **Sales orders** — `src/lib/sales-orders.ts` (creation, status
   transitions, edits) → `applySalesOrderInventoryEffect()` /
   `applySalesOrderLineMovements()` in `stock.ts`.
2. **Purchase order receiving** — `src/lib/purchase-orders.ts` →
   `applyGoodsReceiptInventoryEffect()` in `stock.ts`.
3. **Manual adjustments** — `POST /api/inventory/adjust` →
   `recordStockMovement()` directly.

## Sales orders

### The rule, in one sentence

**Inventory for a sales order leaves the warehouse exactly once, the first
time that order reaches a stock-consuming status — and is returned exactly
once, only for whatever amount is currently actually held — no matter how
many times the order is edited, resent, or raced against itself.**

### What counts as a stock-consuming (holding) status

`CONFIRMED`, `SHIPPED`, and `DELIVERED` are all **stock-holding** statuses —
an order in any of these is expected to currently hold a deduction.
`CONFIRMED` is the transition that actually deducts stock in the normal
flow (`DRAFT → CONFIRMED → SHIPPED → DELIVERED`); `SHIPPED` and `DELIVERED`
add nothing on top once already deducted. `SHIPPED` (or, unusually,
`DELIVERED`) only deducts if the order reaches it without ever passing
through `CONFIRMED` — the sales-order API does not itself enforce the
frontend's transition graph, so a direct jump is possible.

**The rule is not "CONFIRMED deducts, everything else never does."** It is:
*whichever stock-holding status this order reaches first is the one that
deducts, and every stock-holding status after that is a no-op for
inventory* — enforced by checking the actual ledger, not by special-casing
status names.

`DRAFT` never deducts. `CANCELLED` is not stock-holding: it *returns*
whatever is currently held (see below).

### Cancellation

`CANCELLED` restores inventory **only if it is currently net-deducted** —
see "How the check works" below. Cancelling a `DRAFT` order does nothing.
Cancelling a `CONFIRMED`/`SHIPPED`/`DELIVERED` order reverses exactly the
amount currently reflected as deducted (the order's current item
quantities at the moment of cancellation — see "Editing" below for why this
is safe even after edits).

### How the "is this currently deducted" check works

`hasDeductedStock(orderId, db)` in `stock.ts` computes the **net** of the
ledger for this order: `sum(OUT.quantity) - sum(IN.quantity)` across every
`StockMovement` with `referenceType: 'SALES_ORDER', referenceId: orderId`.
If that net is positive, the order currently holds a deduction.

This is deliberately **net**, not "does an OUT movement exist" — a plain
existence check was sufficient for Phase 0 (deduct once, cancel once, done)
but is not sufficient now that an order can go through multiple
reverse/reapply cycles via editing (below): the *original* OUT movement is
never deleted (history is never rewritten — see "Preserving history"), so
an existence check would keep seeing it as "deducted" even after a later
edit has fully reversed it. Net sum is accurate regardless of how many
cycles an order has been through.

- `CONFIRMED` / `SHIPPED` reaching a stock-holding status: if the net is
  already positive, do nothing. Otherwise deduct the order's current
  tracked items now.
- `CANCELLED`: if the net is positive, reverse it by posting an IN for the
  order's current tracked items. Otherwise do nothing.

### Editing a sales order (SYSTEM_AUDIT.md D2)

`PUT /api/sales-orders/[id]` can change an order's items **and its status**
(the edit form includes a status field) via
`updateSalesOrderWithInventoryReconciliation()` in `src/lib/sales-orders.ts`.
Before this hardening pass, this route replaced items directly with no
stock interaction at all — an order already holding a deduction that was
then edited (quantities changed, or status changed via this same route)
left `StockMovement` permanently out of sync with what the order now says,
and cancelling afterward would restore the *edited* amount, not the amount
actually taken.

The fix, applied inside one transaction per edit:

1. Read the order's current items and whether it currently holds a
   deduction (`hasDeductedStock`), **before** touching anything.
2. Replace the items and update the status as requested.
3. If it was previously deducted **and** either the tracked item lines or
   the status actually changed: reverse the *previous* lines (an IN for
   each) — this returns exactly what was actually on the ledger, not
   whatever the new quantities say.
4. If the order's *new* status is stock-holding and it is not already
   net-deducted (true immediately after step 3, or true from the start if
   it was never deducted): deduct the *new* lines (an OUT for each).
5. If the new status is `CANCELLED`, the normal cancellation check
   (`applySalesOrderInventoryEffect`) runs, which is now correctly a no-op
   if step 3 already zeroed it out.

Net effect: editing a CONFIRMED order's quantity from 10 to 15 posts an IN
10 (reversal) then an OUT 15 (reapply) — two new ledger rows, StockLevel
ends up exactly 15 lower than before any of this started. Editing *and*
cancelling an order in the same request (the exact D2 scenario) reverses
only the 10 that was actually taken, regardless of what the edited
quantity says. Resubmitting an identical edit (nothing actually changed)
posts nothing at all.

Creating a new order directly with a non-`DRAFT`, stock-holding status
(`createSalesOrderWithInventoryEffect()`) deducts immediately in the same
transaction — previously, creation never went through the status-transition
logic at all, so a sales order created as CONFIRMED would never have its
stock effect applied.

### Idempotency

Two layers, working together:

1. **Same-status resend** (e.g. clicking "Mark Confirmed" twice): the
   status transition itself is a no-op — `transitionSalesOrderStatus()`
   returns immediately with `changed: false` when the requested status is
   already the order's current status.
2. **Ledger-based no-op**: the net-deduction check makes any deduction or
   reversal a no-op once its condition is already satisfied — covering
   "different transition, same net effect" (CONFIRMED then SHIPPED) and
   "edit resubmitted with nothing changed."

### Concurrency

- **Status transitions**: the status change is a single conditional
  `UPDATE ... WHERE id = ? AND status = ?` inside the same transaction as
  the inventory effect. Postgres's row lock on that UPDATE serializes every
  transition for a given order (not just same-status ones), so the
  ledger check inside the transaction never races against another
  transition for the same order.
- **Edits**: `updateSalesOrderWithInventoryReconciliation()` takes a
  Postgres advisory transaction lock keyed by the order id
  (`pg_advisory_xact_lock(hashtext(orderId))` — the same pattern already
  used by invoice creation) before reading the "before" snapshot, so two
  concurrent edits to the same order can't both read stale state; the
  second waits for the first to commit and reconciles against its result.

## Purchase order receiving (SYSTEM_AUDIT.md D3)

`receiveGoodsForPurchaseOrder()` in `src/lib/purchase-orders.ts` (called
from `POST /api/purchase-orders/[id]/receive`):

- **Transactional**: creating the `GoodsReceipt` (+ items), posting the IN
  stock movements, incrementing each item's `quantityReceived`, and
  updating the PO's status all happen in one `prisma.$transaction`.
  Previously these were four separate, unguarded calls — a crash partway
  through could record a receipt with no stock effect, or increment
  `quantityReceived` without a matching movement.
- **Over-receiving is rejected, not clamped**: before writing anything, each
  requested item's quantity is checked against
  `purchaseOrderItem.quantity - quantityReceived` (the true remaining
  amount as of the current transaction). If any item would exceed its
  ordered quantity, the whole request is rejected (`OverReceiptError`, no
  partial write) rather than silently over-receiving or silently clamping
  the number. A **genuinely new partial shipment within the remaining
  quantity is still allowed** — purchase orders are routinely received in
  multiple batches; this only blocks amounts that don't fit.
- **"Repeated receiving"**: the system cannot distinguish "the same click
  fired twice" from "two separate shipments that happen to be the same
  size" without a client-supplied idempotency key, which this pass
  deliberately does not add (see "Do not invent a new business model" in
  the design notes). Instead, the over-receiving guard is the backstop: a
  duplicate submission that would push any item's total received past what
  was ordered is rejected; one that still fits within the remaining
  quantity is accepted as a legitimate additional receipt. This is
  documented behavior, not an oversight.
- **Idempotent at the movement level too**: `applyGoodsReceiptInventoryEffect()`
  itself is a no-op if a `StockMovement` already exists for that specific
  `GoodsReceipt` id — defense in depth in case it is ever invoked twice for
  the same receipt.
- **Concurrency**: a Postgres advisory transaction lock keyed by the
  purchase order id serializes concurrent receiving against the same PO,
  so two requests racing to receive against the same remaining budget can't
  both read "there's enough left" before either has written — the second
  sees the first's committed increment and is checked against the true
  remaining amount.

## Manual adjustments

`POST /api/inventory/adjust` calls `recordStockMovement()` directly with
`referenceType: 'MANUAL_ADJUSTMENT'` and no `referenceId` — each submission
is treated as an independent, deliberate human action, not a retryable
system request. There is intentionally no dedup/idempotency layer here:
submitting two manual adjustments that happen to look identical creates two
real, distinct movements, because that's what actually happened (two
separate corrections). This is unchanged by this hardening pass.

What *is* hardened: manual adjustments (like every other path) now go
through the floor-at-zero, race-safe `StockLevel` update described below.

## Never negative, and safe under concurrency (StockLevel update)

`recordStockMovement()`'s `StockLevel` update was previously a plain
Prisma `increment`, which had two gaps:

1. Nothing stopped an `OUT` larger than what's on hand from driving
   `StockLevel.quantity` negative (the movement's own *create* path floored
   at zero for a brand-new row, but the *update* path for an existing row
   did not).
2. Two concurrent writers to the same (variant, warehouse) row could, in
   principle, both need this floor applied at once.

Both are now fixed by one atomic statement: the update is a raw
`UPDATE "StockLevel" SET quantity = GREATEST(0, quantity + $delta) WHERE
"productVariantId" = $1 AND "warehouseId" = $2`. Postgres computes the new
value from the row's current value *at the moment of the UPDATE*, as a
single atomic operation — there is no read-then-write gap in application
code for a concurrent writer to land in, and the result can never be
negative regardless of how large a single OUT (or a burst of concurrent
OUTs) is relative to what's on hand. If the row doesn't exist yet, it is
created (floored at zero the same way); a concurrent create-race is caught
(`P2002`) and retried as the same atomic update.

The `StockMovement` row itself always records the real requested quantity —
the audit trail is never adjusted to make the numbers look consistent with
the floor; only the derived `StockLevel` is floored.

## External sync (not part of the movement ledger)

WooCommerce product sync (`src/lib/wordpress/woocommerce.ts`) sets
`StockLevel.quantity` to an **absolute** value reported by WooCommerce on
every sync — it does not create `StockMovement` rows and is not part of
the reverse/reapply or over-receipt machinery described above. This is a
deliberate, pre-existing design (WooCommerce is the source of truth for its
own SKUs) and out of scope for this hardening pass; it is naturally
idempotent (re-syncing the same number twice has no additional effect) and
carries no duplicate-movement risk, but the CRM and WooCommerce can
silently diverge if the CRM is ever used to sell a WooCommerce-tracked SKU
directly (already noted in `docs/SYSTEM_AUDIT.md`, section J).

## Preserving history

None of this ever deletes, edits, or reinterprets an existing
`StockMovement` row. Every reconciliation (edit reversal/reapply,
cancellation) only ever *adds* new rows; every movement already in the
ledger — including ones created before this fix, under the previously
buggy behavior — is left exactly as it was.

**Known effect of pre-fix history:** any real order that was edited after
being confirmed/shipped, before this fix was deployed, may have its item
quantities out of sync with what the ledger actually reflects — this
history is not rewritten (per instructions), so a manual review of
affected orders' `StockLevel` may still be warranted. Likewise, any real
order that went through the earlier `CONFIRMED → SHIPPED` double-deduction
bug (fixed in the Phase 0 follow-up) still has its extra historical `OUT`
movement on record.
