# Financial Accuracy & Automation Reliability

**Date:** 2026-09-25 (Phase 11)
**Status:** Implemented and tested. This document is the explicit behavior —
code should match this, not the other way around.

## What this is

Three fixes from `docs/SYSTEM_AUDIT.md`, all still open as of Phase 10:

- **L** — WooCommerce orders paid online were counted as "sold" in Finance
  but never as "received," because nothing ever created a `Payment` row
  for one.
- **K** — a WooCommerce refund was indistinguishable from a plain
  cancellation (`mapWooStatus()` mapped both to `CANCELLED`).
- **E2** — completing an overdue-invoice follow-up task let the very next
  scheduler tick immediately recreate it and resend the reminder email.

## L — WooCommerce paid orders record a Payment

When `syncWooCommerce()` (`src/lib/wordpress/woocommerce.ts`) syncs an
order whose **WooCommerce status** (not the mapped `SalesOrderStatus`) is
`processing` or `completed`, `recordPaymentForPaidWooOrder()` runs
immediately after that order's `SalesOrder` upsert:

1. **Ensures an Invoice exists** for the order via the same
   `createInvoiceForSalesOrder()` the "Create Invoice" button already
   uses — idempotent (reuses a manually-created invoice for the order
   rather than duplicating it), triggered with `createdById: null` (a
   system action, not attributable to a signed-in user — `Invoice.createdById`
   is nullable for exactly this).
2. **Records a `Payment`** against that invoice for the order's full
   `total`, `method` from WooCommerce's `payment_method_title` (falling
   back to the literal string `"WooCommerce"` when absent), `paidAt` from
   `date_paid_gmt` (falling back to `date_created_gmt`, then now).
3. **Updates the invoice's `amountPaid`/`status`** via the same shared
   `deriveInvoiceStatus()` every other payment-recording path in this app
   uses (`docs/ACCOUNTS_RECEIVABLE.md`). A freshly auto-created invoice
   starts as `DRAFT` (schema default); since `deriveInvoiceStatus()`
   deliberately never moves a `DRAFT` invoice on its own (a rule that
   exists for a genuinely not-yet-issued human-managed invoice), this one
   is evaluated as if it started `SENT` instead — the amount-paid-vs-total
   precedence then correctly resolves it straight to `PAID`.

### Idempotency

`Payment` gained `externalSource`/`externalId` columns and a
`@@unique([externalSource, externalId])` constraint this phase — the same
pattern every other WooCommerce-synced model already uses. `externalId` is
the WooCommerce order id, so re-syncing an already-recorded paid order
finds the existing `Payment` and does nothing further; it can never record
a second one for the same order.

### Finance impact

`getFinanceSummary()`'s `received` figure (`src/lib/finance.ts`) already
sums every `Payment` row unconditionally — no change was needed there. The
moment a real `Payment` row exists for a paid WooCommerce order, it flows
into "received" by construction, the same as any other payment.

### Known limitations

- **Assumes full payment.** WooCommerce's REST API doesn't expose a
  distinct "amount paid so far" for a simple order — `processing`/
  `completed` are the statuses a standard checkout only reaches once its
  payment gateway confirms full payment, so the order's own `total` is
  recorded as the payment amount. Split/partial payments on a single
  WooCommerce order are not represented.
- **A manually-recorded payment for the same order, entered before the
  order was ever synced in a paid state, is not detected or merged** —
  this could double-count in the unlikely event staff manually enter a
  payment for an order WooCommerce already reports as paid. Not addressed
  this phase; flagged here rather than silently risked.

## K — Refunded orders are distinct from cancelled

`SalesOrderStatus` gained a `REFUNDED` value. `mapWooStatus()` now maps
WooCommerce's `refunded` status to `REFUNDED`, separately from `cancelled`/
`failed` (still `CANCELLED`).

`REFUNDED` is **never manually selectable** — absent from every hardcoded
transition list (`OrderActions.tsx`'s `NEXT_STATUS`, the status API
route's zod enum, the order-creation schema in `validation.ts`) and from
`STOCK_HOLDING_STATUSES` (`src/lib/automations/stock.ts`), the same way
`CANCELLED` already is: a refunded sale doesn't count as current stock
held, or as revenue in Finance/Profitability/the Management Dashboard —
all of those already filter by an explicit allow-list of statuses that
`REFUNDED` was never added to.

### Payment reversal

`reverseWooOrderPaymentIfRefunded()` mirrors the existing Stripe refund
handler's own logic exactly (`handleChargeRefunded` in
`src/lib/stripe/webhook.ts`, `docs/STRIPE_INTEGRATION.md`): tracked via
`Payment.refundedAmount` (the same field Stripe refunds already use, not a
second parallel one), idempotent by comparing against the delta already
applied, and re-derives the invoice's `amountPaid`/`status` the same way.

Treats a WooCommerce `refunded` order as a **full** refund of whatever was
recorded as paid for it — WooCommerce's order-level status doesn't
distinguish a partial from a full refund (a partial refund normally leaves
the order in its prior status with a separate refund record this sync does
not fetch). If no `Payment` was ever recorded for the order (refunded
before ever being synced in a paid state), there's nothing to reverse —
logged as a warning rather than fabricating one.

## E2 — Overdue-invoice reminder cooldown

`checkOverdueInvoices()` (`src/lib/automations/engine.ts`) now checks, for
each invoice it finds newly/still overdue, whether a `payment_reminder`
was **successfully sent** (`CommunicationLog.status = 'SENT'`, Phase 10's
audit trail — reused, not a new tracking mechanism) within the last
`PAYMENT_REMINDER_COOLDOWN_DAYS` (7). If so, **both** the follow-up task
recreation and the reminder send are skipped for that tick — not just the
email. This is the fix for the actual reported bug: completing the
follow-up task early used to be enough, on its own, to let the very next
tick recreate it and resend the reminder; now the cooldown is keyed on
when a reminder was actually sent, independent of task status.

A **failed** send attempt does not start the cooldown — the invoice is
just as unreminded as before that attempt, so the next tick retries
immediately rather than waiting out 7 days for what might have been a
transient SMTP outage.

The boundary math is a small, pure, directly-tested function:

```ts
export function isReminderCooldownActive(
  lastSentAt: Date | null,
  now: Date,
  cooldownDays: number = PAYMENT_REMINDER_COOLDOWN_DAYS
): boolean
```

`null` (never sent) never blocks. The invoice's own `OVERDUE` status
update is unaffected by the cooldown — only the task/reminder step is
gated.

## Testing

- `tests/woocommerce-payment-reconciliation.test.ts` — payment recording
  for `processing`/`completed` orders, invoice auto-creation and reuse,
  idempotency across repeated syncs, `payment_method_title` mapping,
  Finance "received" reflecting the new payment, refund reversal
  (including the idempotent-re-refund and never-paid-then-refunded edge
  cases), and a regression check that plain `cancelled`/`failed` orders are
  unaffected.
- `tests/overdue-reminder-cooldown.test.ts` — pure boundary-math tests for
  `isReminderCooldownActive` (exactly-N-days, one ms either side, a custom
  window, future-dated clock skew) plus database-backed tests proving the
  cooldown suppresses both task recreation and the reminder send, that a
  failed attempt doesn't start it, and that completing the task early
  doesn't bypass it.
- Both new migration columns/enum value are purely additive — no existing
  row is touched, and no existing `CANCELLED` order is retroactively
  reclassified as `REFUNDED`.
