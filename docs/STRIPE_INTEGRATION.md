# Stripe Integration

**Date:** 2026-09-24 (Phase 4)
**Status:** Implemented and tested. This document is the explicit
behavior — code should match this, not the other way around.

## What this is (and isn't)

This phase implements the **receiving/reconciliation side** of Stripe
payments: a webhook endpoint that takes verified Stripe events and
reconciles them into this app's existing `Invoice`/`Payment` records. It
does **not** implement a checkout flow or a "Pay with Stripe" button —
creating a `PaymentIntent` (e.g. from an invoice page) is a natural
follow-on that would call the Stripe API directly from wherever that UI
lives; this phase only needs to agree on the contract that makes that
future PaymentIntent reconcilable (see "PaymentIntent → Invoice linking"
below), and does not require building it to be complete.

## Environment variables

No secrets appear in code, in git, or in logs — both are read strictly
from the environment:

| Variable | Purpose |
|---|---|
| `STRIPE_SECRET_KEY` | Server-side Stripe API key (placeholder: `sk_live_...` / `sk_test_...`). Only used to construct the Stripe SDK client (needed even for local signature verification, which the SDK exposes as an instance method). |
| `STRIPE_WEBHOOK_SECRET` | The signing secret for this specific webhook endpoint, from the Stripe Dashboard's Webhooks page (placeholder: `whsec_...`). Used to verify every incoming request actually came from Stripe. |

Neither variable has a default or fallback — `src/lib/stripe/webhook.ts`
throws immediately if either is missing, rather than silently proceeding
unauthenticated or against the wrong account.

## Webhook endpoint

`POST /api/stripe/webhook` — configure this exact URL in the Stripe
Dashboard's Webhooks settings, subscribed to at minimum:
`payment_intent.succeeded`, `payment_intent.payment_failed`,
`charge.refunded`.

- Excluded from the app's session-auth middleware (`src/middleware.ts`),
  the same way the existing WhatsApp and WordPress-leads webhooks are —
  Stripe requests never carry this app's session cookies, so the
  **signature check is the entire authentication** for this route.
- The raw request body is read with `req.text()` (not `req.json()`) and
  passed untouched to Stripe's signature verification — signing is
  computed over the exact bytes Stripe sent, so parsing the body first
  (even just to re-stringify it identically) risks breaking verification.
- An invalid or missing `stripe-signature` header is rejected with `400`
  before anything in the body is trusted, parsed for business logic, or
  written anywhere (`verifyStripeSignature()` in
  `src/lib/stripe/webhook.ts`, tested directly in
  `tests/stripe-webhook.test.ts`).
- A genuine processing failure (DB error, unexpected event shape) returns
  `500` — a non-2xx response, so Stripe's own retry mechanism redelivers
  the event later — and is logged to `AutomationLog` so it's visible to
  staff, not just a container log line.
- A successfully processed event (including one that turned out to have
  nothing to reconcile — see "Unhandled/inapplicable events" below)
  returns `200`.

## Webhook idempotency

Stripe delivers webhooks **at least once** — the same event can arrive
twice (a retried delivery after a slow response, a dashboard-triggered
resend, network retries). **The same event must never create a duplicate
Payment or double-adjust an Invoice.**

This is enforced by a dedicated `StripeWebhookEvent` table
(`stripeEventId` unique) plus a specific ordering inside
`processStripeWebhook()`:

1. Verify the signature (outside any transaction — a request that fails
   this never reaches the database at all).
2. Inside **one** `prisma.$transaction`: attempt to `create()` a
   `StripeWebhookEvent` row keyed by `event.id`. If this hits the unique
   constraint (`P2002`), this exact event was already processed — return
   `{ duplicate: true }` immediately, without touching `Payment` or
   `Invoice` a second time.
3. Only if that insert succeeded does the transaction go on to apply the
   event's effect (create a `Payment`, adjust an `Invoice`, or log a
   no-op).

Because the event-id insert and the actual reconciliation happen in the
**same** transaction, a crash between them is impossible by construction
— either both commit together, or neither does (and Stripe's retry will
try the same event again, safely, from a clean slate).

There's a second, narrower idempotency guard purely as defense in depth:
`Payment.stripePaymentIntentId` is also unique, so even if some future
code path ever called the `payment_intent.succeeded` handler outside the
event-id guard, a second Payment for the same PaymentIntent still
couldn't be created.

## PaymentIntent → Invoice linking (Stripe Customer / Payment Intent mapping)

- **Company ↔ Stripe Customer:** `Company.stripeCustomerId` (unique,
  nullable) — set whenever a Stripe Customer is created for that company
  (not done by this phase, since it doesn't build the checkout side, but
  the column exists for whatever creates PaymentIntents next to use).
- **Invoice ↔ PaymentIntent:** a `PaymentIntent` reconciles to an
  `Invoice` via **`metadata.invoiceId`**, which whatever creates the
  PaymentIntent must set to that invoice's id. This is the standard Stripe
  pattern for tying a payment back to your own record (Stripe has no
  built-in concept of "this app's Invoice"). A `payment_intent.succeeded`
  event with no `metadata.invoiceId`, or one naming an invoice this app
  doesn't have, is accepted (`200`, so Stripe doesn't retry forever) but
  not applied to anything — logged to `AutomationLog` instead of silently
  discarded or crashing the webhook.
- **Payment ↔ PaymentIntent/Charge:** `Payment.stripePaymentIntentId`
  (unique) and `Payment.stripeChargeId` record exactly which Stripe
  objects produced that Payment row — this is also how a later refund
  event finds its way back to the right Payment.

## Payment lifecycle

| Event | Effect |
|---|---|
| `payment_intent.succeeded` | Creates one `Payment` (`method: "stripe"`, `reference`/`stripePaymentIntentId` = the PaymentIntent id, `stripeChargeId` = its latest charge, `paidAt` = now, `amount` = `amount_received` in cents → dollars). Increments `Invoice.amountPaid` by that amount and recomputes status (see below). |
| `payment_intent.payment_failed` | No `Payment` row, no `Invoice` change — no money moved. Logged to `AutomationLog` (with the failure reason) so a failed customer payment is visible to staff instead of vanishing silently. |
| `charge.refunded` | Finds the `Payment` by the charge's `payment_intent`. Sets `Payment.refundedAmount` to the charge's own cumulative `amount_refunded` (not a delta computed independently — see "Refunds" below) and decrements `Invoice.amountPaid` by however much *changed* since the last time this charge's refund state was recorded. |
| anything else | Accepted (`200`) but not acted on — see "Known limitations". |

**Invoice status** is recomputed the same way after every reconciling
event, using the exact same rule the pre-existing manual "record a
payment" route already uses (`src/app/api/invoices/[id]/payments/route.ts`)
— this phase doesn't invent a second, different rule for Stripe-originated
payments:

- `amountPaid <= 0` → `SENT`
- `amountPaid >= total` → `PAID`
- otherwise → `PARTIAL`

**A "partial payment" isn't a distinct Stripe event** — it's simply a
`payment_intent.succeeded` event whose `amount_received` is less than the
invoice's remaining total, which the status rule above naturally leaves as
`PARTIAL` rather than `PAID`. `tests/stripe-webhook.test.ts` covers this
explicitly.

## Refunds (full and partial)

A refund is read from the charge's own **cumulative** `amount_refunded`
field (what Stripe itself considers "how much of this charge has been
refunded so far, in total"), not accumulated by summing individual refund
events. The stored `Payment.refundedAmount` is compared against that
cumulative figure, and only the **delta** is applied to
`Invoice.amountPaid`:

- **Full refund:** `amount_refunded` equals the original charge amount →
  `refundedAmount` reaches the full `Payment.amount` → the delta fully
  reverses what was added to `Invoice.amountPaid`, and the invoice's
  status rule naturally recomputes it back to `SENT` (assuming no other
  payment exists on it).
- **Partial refund:** `amount_refunded` is less than the full amount →
  only that much is reversed → the invoice may land back on `PARTIAL`
  (rather than `SENT`) if some balance is still paid.
- **A second `charge.refunded` event for the same charge** (Stripe fires
  this again if more is refunded later, or redelivers the same one) is
  handled correctly either way: if `amount_refunded` hasn't increased
  since last recorded, the delta is `≤ 0` and nothing happens (a true
  duplicate); if it has increased (a *second, larger* partial refund),
  only the additional amount is newly reversed.

**Unknown payment intent:** a `charge.refunded` event whose
`payment_intent` doesn't match any `Payment.stripePaymentIntentId` on file
(the charge's PaymentIntent was never recorded here — e.g. a payment made
before this integration existed, or genuinely out-of-band) is accepted and
logged, not crashed or silently dropped. Covered directly in
`tests/stripe-webhook.test.ts`.

## Invoice and sales-order reconciliation

Reconciliation only ever writes to `Invoice` (status, `amountPaid`) and
creates/updates `Payment` rows — it never writes anything new to
`SalesOrder`. This is deliberate, not an oversight: `Invoice.salesOrderId`
already links an invoice back to the sales order it was generated from (a
pre-existing field, unchanged by this phase), so a sales order's payment
status is always available by following that link — adding a second,
separately-maintained "paid" figure on `SalesOrder` itself would create
exactly the kind of duplicate financial data Phase 3
(`docs/CUSTOMER_360.md`) was explicit about avoiding. The Customer 360
view's existing financial summary (`src/lib/customer-360.ts`) picks up
Stripe-driven payments automatically, with no Stripe-specific code of its
own, because it already aggregates from `Invoice.total`/`amountPaid`.

## Failure handling

Every place this integration can fail is handled explicitly, not left to
throw an unhandled exception into the webhook route:

- **Bad/missing signature** → `400`, nothing processed, nothing logged as
  a "failure" (this is expected traffic — scanners, misconfigured
  webhooks, etc. — not a system error).
- **Missing env vars** (`STRIPE_SECRET_KEY`/`STRIPE_WEBHOOK_SECRET`) →
  throws immediately; surfaces as a `500` from the route (a genuine
  configuration problem, correctly not swallowed).
- **`metadata.invoiceId` missing or unresolvable**, **unknown
  PaymentIntent on a refund**, **a failed PaymentIntent** → all handled
  gracefully (event accepted, `200`, nothing crashes) and logged to
  `AutomationLog` (`entityType: "STRIPE_WEBHOOK"`) for visibility, matching
  the pattern already established for WooCommerce sync issues
  (`docs/WOOCOMMERCE_INTEGRATION.md`) and the WhatsApp webhook.
- **An actual unexpected exception** (DB connection drop mid-transaction,
  etc.) → the whole transaction rolls back atomically (nothing
  half-applied), the route returns `500`, and Stripe retries delivery
  later.

## Known limitations

- **No checkout/PaymentIntent-creation UI** — see "What this is (and
  isn't)" above. Building it is a natural next step, not part of this
  phase.
- **Only three event types are handled** (`payment_intent.succeeded`,
  `payment_intent.payment_failed`, `charge.refunded`). Others Stripe might
  send for a fuller integration — `payment_intent.canceled`,
  `charge.dispute.created`, `customer.updated`, subscription-related
  events, etc. — are accepted (so Stripe doesn't retry them forever) but
  not acted on. Extending coverage means adding a `case` in
  `processStripeWebhook()`'s switch statement; the idempotency and
  transaction structure around it doesn't need to change.
- **No automatic Stripe Customer creation** — `Company.stripeCustomerId`
  exists as a place to store the mapping once something creates a Stripe
  Customer (e.g. a future checkout flow), but nothing in this phase
  populates it.
- **Overpayment isn't specially handled** — if a `payment_intent.succeeded`
  amount pushes `amountPaid` above `total`, the status rule still reports
  `PAID` (never a distinct "overpaid" state) — this matches the
  pre-existing manual-payment route's behavior exactly; not a new gap
  introduced here.
