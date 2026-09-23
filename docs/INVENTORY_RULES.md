# Sales Order → Inventory Rules

**Date:** 2026-09-22 (Phase 0 follow-up)
**Status:** Implemented and tested. This document is the explicit business
rule — code should match this, not the other way around.

## The rule, in one sentence

**Inventory for a sales order leaves the warehouse exactly once, the first
time that order reaches a stock-consuming status — and is returned exactly
once, only if it had actually left.**

## What counts as a stock-consuming status

`CONFIRMED` and `SHIPPED` are both "stock-consuming" statuses. In the normal
flow (`DRAFT → CONFIRMED → SHIPPED → DELIVERED`), **`CONFIRMED` is the
transition that actually deducts stock** — by the time an order reaches
`SHIPPED`, its stock was already deducted at `CONFIRMED`, so the `SHIPPED`
transition has **no inventory effect** in the normal flow.

`SHIPPED` is only ever the deducting transition if an order somehow reaches
`SHIPPED` without ever having been `CONFIRMED` first (the sales-order API
does not itself enforce the frontend's transition graph, so this is
possible via a direct API call even though the UI never offers it). In that
case, `SHIPPED` deducts stock, because *something* has to, and it would be a
worse bug to mark an order shipped and never remove its stock at all.

**The rule is not "CONFIRMED deducts, SHIPPED never does."** It is: *whichever
stock-consuming status this order reaches first is the one that deducts,
and every stock-consuming status after that is a no-op for inventory.* This
is enforced by checking the actual `StockMovement` ledger — not by
special-casing status names — so it's correct regardless of which order the
statuses happen in.

## What does NOT deduct or restore inventory

- `DRAFT` — never deducts. A draft order is not a commitment yet.
- `DELIVERED` — no inventory effect. Stock already left at whichever earlier
  status triggered the deduction; `DELIVERED` is a fulfillment/logistics
  marker only.
- A **second** `CONFIRMED` or `SHIPPED` call on an order that already
  deducted stock — idempotent no-op (see "Idempotency" below).

## Cancellation

`CANCELLED` restores (returns) inventory **only if stock was actually
deducted for this order** — checked the same way, against the
`StockMovement` ledger. Cancelling a `DRAFT` order (which never deducted
anything) does not create a phantom "returned" movement; cancelling a
`CONFIRMED` or `SHIPPED` order (which did deduct) reverses that deduction
with matching `IN` movements.

Once cancelled, a **second** `CANCELLED` call is idempotent — see below.

## How the deduction/restoration check works

Every stock-consuming or stock-restoring call first checks whether a
`StockMovement` row of type `OUT` already exists for this order
(`referenceType: 'SALES_ORDER', referenceId: <orderId>`):

- `CONFIRMED` / `SHIPPED`: if an `OUT` movement already exists for this
  order, do nothing (already deducted, by an earlier transition). If none
  exists, create one `OUT` movement per tracked item now.
- `CANCELLED`: if an `OUT` movement exists for this order, create matching
  `IN` movements now (reverse it). If none exists, do nothing (there was
  never anything to return).

This uses the existing audit trail as the single source of truth, rather
than adding a new "has this been deducted" flag that could itself drift out
of sync with the actual movements.

## Idempotency

Two layers, working together:

1. **Same-status resend** (e.g. clicking "Mark Confirmed" twice, or a
   retried request whose first attempt actually already succeeded): the
   status transition itself is a no-op — `transitionSalesOrderStatus()`
   returns immediately with `changed: false` when the requested status is
   already the order's current status. The inventory-effect code is not
   even called.
2. **Different transition, same net effect** (e.g. `CONFIRMED` already
   deducted, then `SHIPPED` is requested as a genuinely new, different
   transition): this is *not* a same-status resend, so the status change
   itself proceeds — but the inventory-effect function's ledger check (see
   above) makes the deduction part of it a no-op.

Together, these mean **repeating the same status request, or moving through
CONFIRMED → SHIPPED → DELIVERED in the normal sequence, never creates more
than one `OUT` movement for a given order** — and cancelling never creates
more than one reversing `IN` movement.

## Concurrency

The status change and its inventory effect run inside **one database
transaction**, and the status change itself is a single conditional
`UPDATE ... WHERE id = ? AND status = ?` (see `docs/SYSTEM_AUDIT.md` C1 and
`transitionSalesOrderStatus()` in `src/lib/sales-orders.ts`). Postgres
guarantees that update is atomic: if a concurrent request already moved the
order away from the status this call last read, the update matches zero
rows and the call throws a conflict instead of proceeding.

This has a useful side effect for the inventory-ledger check too: because
the outer status-CAS serializes **every** transition for a given order (not
just same-status ones — two different target statuses racing for the same
order can also only have one winner at a time), by the time the
ledger-existence check runs, no other transition for that same order can be
concurrently modifying it. So the "check the ledger, then conditionally
write" step is safe from races without needing its own separate lock.

## Preserving history

None of this ever deletes, edits, or reinterprets an existing
`StockMovement` row. The fix only changes whether a *new* movement gets
created for a given order; every movement already in the ledger — including
ones created before this fix, under the old buggy double-deduction
behavior — is left exactly as it was.

**Known effect of the bug this document describes:** any real order that
went through `CONFIRMED → SHIPPED` before this fix was deployed will have
**two** `OUT` movements (double the correct amount) recorded against it, and
`StockLevel` for the items involved will be over-deducted by the same
amount. This history is not rewritten by the fix (per instructions), so a
manual review/correction of affected orders' `StockLevel` may be needed
separately — see "Remaining inventory risks" in the Phase 0 follow-up
report.
