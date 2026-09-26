# Automation System: Execution Contract & Idempotency

**Date:** 2026-09-26 (Phase 13)
**Status:** Implemented and tested. This document is the explicit behavior —
code should match this, not the other way around.

## What this is

An audit and hardening pass over the existing automation system (the
scheduled checks in `src/lib/automations/engine.ts`, the automated customer
notifications in `src/lib/automations/notifications.ts`, and the
human-triggered write paths that can be double-submitted). It does not add
a new automation engine, queue, or scheduler — it standardizes how the
automation that already exists reports its own outcome, and closes the
specific gaps where a retry (a scheduler double-tick, a network retry, a
double-click) could have produced a duplicate customer message or a
duplicate financial record.

Two new tables carry the whole system: `AutomationJobRun` (the execution
contract) and `IdempotencyKey` (the deduplication primitive). Both are
purely additive — no existing table changed.

## Why "do not create uncontrolled automation"

The retry/backoff behavior below deliberately rides the *existing*
15-minute scheduler tick cadence (`runAutomationsTickExclusive()`,
`docs/SYSTEM_AUDIT.md` D4, fixed in `docs/SYSTEM_HARDENING.md`) instead of
introducing a new queue or scheduling engine. A job that keeps failing for the same entity stops
being retried automatically after `maxAttempts` consecutive failures and
is left in a terminal `FAILED` state for a human to see in the admin
view — it does not retry forever, and nothing here runs on its own timer.

## 1. Standardized Automation Execution Contract

`src/lib/automations/job-run.ts` exports `runAutomationJob(opts, fn)`. It
wraps a job function and guarantees:

- **trigger** — a free-text string (`'SCHEDULER_TICK'`, `'CRON'`, a manual
  route) recording what caused this run.
- **conditions** / **action** — optional metadata describing what the job
  checked and did, for readability in the admin view.
- **status** — `PENDING` (not used directly; a row is created straight
  into `RUNNING`) → `RUNNING` → `COMPLETED` | `FAILED` | `RETRYING`.
- **timestamps** — `startedAt` set when the row is created, `finishedAt`
  set on every terminal transition.
- **error state, never swallowed** — on a thrown error, both
  `error.message` and `error.stack` (when the throw is an `Error`; a
  non-`Error` throw still records a usable message) are written to the
  row. Nothing here catches an error and discards it — every failure is
  visible in `AutomationJobRun`.
- **retry behavior with backoff / max attempts** — see below.
- **persistent audit trail** — every run, successful or not, is a
  permanent row (no pruning).

```ts
const result = await runAutomationJob(
  { jobKey: 'overdue_invoices', trigger, action: 'flag_overdue_and_remind' },
  checkOverdueInvoices
);
```

### Retry / backoff policy

`maxAttempts` (default `1`) is per call site. For jobs scoped to a
specific entity (`entityType` + `entityId` both given — e.g. a future
per-invoice job), `runAutomationJob` counts how many `FAILED` **or**
`RETRYING` runs exist for that exact `(jobKey, entityType, entityId)`
since the last `COMPLETED` run, and uses that count to compute the next
`attempt`:

- `attempt < maxAttempts` → failure is recorded as `RETRYING` (a human
  scanning the admin view sees "still trying," not "broken").
- `attempt >= maxAttempts` → failure is recorded as `FAILED` (terminal).
- `attempt > maxAttempts` → the wrapper refuses to even invoke `fn()` and
  returns immediately without writing a new row — the last `FAILED` row
  already explains why, so nothing new needs saying, and nothing retries
  forever.
- A later `COMPLETED` run resets the counter — a job that eventually
  succeeds is not permanently locked out.

Jobs with no `entityType`/`entityId` (the four whole-batch scheduler
checks below — there is no single "entity" a batch check like
`checkLowStock` failed for) are always `attempt` 1 and simply run again
every tick; the batch check itself is naturally idempotent (re-running it
just re-evaluates current state), so there is nothing to back off from.

### What already runs through this

`runScheduledAutomations()` (`src/lib/automations/engine.ts`) wraps all
four built-in scheduler checks:

| jobKey              | action                    | wraps                    |
|---------------------|---------------------------|---------------------------|
| `overdue_invoices`  | `flag_overdue_and_remind` | `checkOverdueInvoices`   |
| `pending_orders`    | `flag_pending_orders`     | `checkPendingOrders`     |
| `low_stock`         | `flag_low_stock`          | `checkLowStock`          |
| `unanswered_emails` | `flag_unanswered_emails`  | `checkUnansweredEmails`  |

Each check's own return value (a count) is preserved in the wrapper's
result and surfaced the same way `runScheduledAutomations()` always has;
the wrapper only adds the surrounding contract, it does not change what
any check does.

## 2 & 3. Idempotency & Deduplication Engine / Trigger Audit

`src/lib/automations/idempotency.ts` exports the primitive every call
site below is built on:

```ts
const claim = await claimIdempotencyKey(key, scope);
if (!claim.claimed) {
  // Someone already claimed this key. claim.existingResultRef is the
  // winner's recorded result (or null if the winner hasn't finished yet).
}
// ...do the side-effecting work...
await recordIdempotentResult(key, someEntityId);
```

`claimIdempotencyKey` is a plain `create()` racing on `IdempotencyKey.key`
(the primary key) — the same fundamental concurrency primitive as
`src/lib/automations/tick-lock.ts`'s lease (`docs/SYSTEM_AUDIT.md` D4,
fixed in `docs/SYSTEM_HARDENING.md`): whichever caller's `INSERT` wins
gets `claimed: true`; every other
caller (even truly concurrent ones) gets `P2002`, which is caught and
turned into `claimed: false`. This is safe under real concurrency, not
just sequential retries — see `tests/idempotency.test.ts`'s 10-way race
test.

### Audit: every trigger involving orders, payments, inventory, invoices, customers, emails, and WhatsApp

| Trigger / call site | Idempotency key | Scope | Rationale |
|---|---|---|---|
| `sendPaymentReminder` (scheduled) | `payment_reminder:invoice:{invoiceId}:{YYYY-MM-DD}` | `automated_notification` | Day-bucketed hard backstop *underneath* Phase 11's 7-day soft cooldown (`isReminderCooldownActive`, which reads `CommunicationLog` after the fact). Two overlapping ticks processing the same invoice can never both send — the DB-level unique claim happens before either sends anything. |
| `sendOrderConfirmation` (scheduled/triggered) | `order_confirmation:sales_order:{orderId}` | `automated_notification` | Once ever — an order is only ever confirmed once, unlike a reminder which legitimately repeats over time. |
| `sendInvoiceByEmail` | *(none, deliberate)* | — | A human-triggered "re-send invoice" action is deliberately repeatable (see `docs/CUSTOMER_COMMUNICATION.md`) — giving it a key would break the feature. |
| Manual "Send communication" form (`sendCommunication`) | client-generated UUID, one per compose, resent verbatim on retry | `communication_send` | Protects against a network retry or a double-click on Send resubmitting the exact same human-reviewed draft. Regenerated only when the user edits the draft (see `src/lib/idempotency-client.ts` and the `useRef` wiring in `SendCommunicationForm.tsx`) — an edited message is a genuinely new send, not a retry. |
| Manual invoice payment (`POST /api/invoices/[id]/payments`) | client-generated UUID from the payment form | `invoice_payment` | A double-submit of "record payment" must not post the same `Payment` twice. |
| Manual supplier-bill payment (`POST /api/supplier-invoices/[id]/payments`) | client-generated UUID | `supplier_payment` | Same guarantee for `SupplierPayment`. |
| Manual inventory adjustment (`POST /api/inventory/adjust`) | client-generated UUID | `inventory_adjust` | A plain "add/remove N units" command has no natural idempotency (unlike the WooCommerce sync's delta-based stock updates, which already are idempotent by construction) — a double-click would otherwise post the movement twice. |
| Company creation (`POST /api/companies`) | client-generated UUID from the form, create-only | `create_company` | Checked *before* the Phase 12 duplicate-name warning, so a genuine retry of an already-accepted "Create anyway" never re-triggers that warning. Not applied to edits (`PUT`). |
| Contact creation (`POST /api/contacts`) | client-generated UUID from the form, create-only | `create_contact` | Same pattern as Company creation. |
| WooCommerce order sync (`syncWooCommerce`) | *(none needed)* | — | Already idempotent by construction: orders are upserted by `wooOrderId`, and `recordPaymentForPaidWooOrder` (`docs/FINANCIAL_ACCURACY_AND_AUTOMATION.md`) is guarded by `Payment.externalSource`/`externalId`'s unique constraint — a second sync of the same order cannot create a second Payment. Pre-existing, unchanged in Phase 13. |
| WhatsApp webhook (`POST /api/whatsapp/webhook`) | *(none needed)* | — | Already deduplicated by `WhatsAppMessage.waMessageId`'s unique constraint (`docs/SYSTEM_AUDIT.md` C3). Pre-existing, unchanged in Phase 13. |
| Automations scheduler tick itself | *(none needed — a lock, not a key)* | — | Already covered by `runAutomationsTickExclusive()`'s lease (`docs/SYSTEM_AUDIT.md` D4, fixed in `docs/SYSTEM_HARDENING.md`): two overlapping ticks can't both run at all, which is a stronger guarantee than idempotency for that one entry point. Pre-existing, unchanged in Phase 13. |

The client-generated keys above all use `newIdempotencyKey()`
(`src/lib/idempotency-client.ts`, `crypto.randomUUID()`), created once via
`useRef` when the form mounts, resent verbatim on any retry of the exact
same submission, and regenerated only when the user actually edits a
field or the send completes — see the comments in `CompanyForm.tsx`,
`ContactForm.tsx`, and `SendCommunicationForm.tsx`.

## 4. Admin Visibility

`/automations` (`src/app/(app)/automations/page.tsx`) now shows, above the
pre-existing "Recent activity" (`AutomationLog`) section:

- **Failed automation jobs** — only rendered when at least one
  `AutomationJobRun` has `status: FAILED`. Each entry shows the job key,
  entity, attempt/maxAttempts, timestamp, the error message, and a
  collapsible `<details>` stack trace — nothing failure-related is ever
  only in container logs.
- **Recent job runs** — the last 20 `AutomationJobRun` rows regardless of
  status, so a healthy system is visibly healthy too.
- **Failed AI generations** / **Recent AI generations** (added when
  Phase 14's AI-Assisted Features shipped) — the same pattern applied to
  `AiGenerationLog` (`docs/AI_FEATURES.md`): only the "Failed" card
  renders when there's at least one, and "Recent" always shows the last
  20 regardless of status. This is currently the only UI for inspecting
  `AiGenerationLog` — there is no dedicated route or page for it, so a
  question that needs more than the last 20 entries (e.g. "how many AI
  calls failed last week") still requires a direct database query.

`GET /api/automations/failures` (`src/app/api/automations/failures/route.ts`)
is a structured JSON view of the last 100 `FAILED` runs, for external
monitoring/alerting to poll. It uses the same dual-auth pattern as the
existing `POST /api/automations/run`: either the shared `CRON_SECRET`
header/query param, or a signed-in `ADMIN` session.

## 5. Testing & Verification

- `tests/idempotency.test.ts` — the `claimIdempotencyKey` /
  `recordIdempotentResult` primitive in isolation: fresh claim, duplicate
  claim, result readback, cross-scope collision (the key itself is the
  unique identity, not `(key, scope)`), and a 10-way concurrent race
  proving exactly one caller ever wins.
- `tests/automation-job-run.test.ts` — `runAutomationJob`: COMPLETED path,
  non-swallowed `Error` capture (message + stack), non-`Error` throw
  capture, RETRYING vs terminal FAILED, per-entity backoff exhaustion (a
  third call after `maxAttempts` is reached does not even write a new
  row), backoff reset after a later COMPLETED run, and whole-batch jobs
  (no entity) always running at attempt 1.
- `tests/communications-send.test.ts` (extended) — a repeated
  `idempotencyKey` on `sendCommunication` invokes the stub sender exactly
  once across two calls and returns the same `communicationLogId`; no key
  sends every time (unchanged default); two different keys both send;
  `sendOrderConfirmation` and `sendPaymentReminder` each called twice for
  the same order/invoice write exactly one `CommunicationLog` row.
- `tests/route-idempotency.test.ts` (new) — calls the actual route
  handlers (not the underlying library functions) with next-auth's
  session lookup stubbed to a fixed ADMIN user, proving a repeated
  idempotencyKey on each of the five manual write routes creates exactly
  one row (`Payment`, `SupplierPayment`, `StockMovement`, `Company`,
  `Contact`) and does not double-apply the financial/inventory side
  effect (e.g. `amountPaid` reflects one payment, not two); a different
  key is confirmed to be a genuinely new request.

Run: `npm run typecheck`, `npm test`, `npm run build`.

## A bug this testing effort caught

Writing `tests/automation-job-run.test.ts`'s backoff-exhaustion test
surfaced a real defect in the first draft of `priorConsecutiveFailures()`:
it counted only `FAILED` rows toward the attempt count, but a job mid-
backoff is deliberately stored as `RETRYING` (not `FAILED`) until its
final attempt — so the attempt count never advanced past 1, and
`maxAttempts` could never actually be reached. Fixed by counting both
`FAILED` and `RETRYING` runs since the last `COMPLETED` one.
