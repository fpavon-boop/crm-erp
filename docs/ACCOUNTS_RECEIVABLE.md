# Accounts Receivable & Invoice Reconciliation

**Date:** 2026-09-23 (Phase 5)
**Status:** Implemented and tested. This document is the explicit behavior —
code should match this, not the other way around.

## What this is (and isn't)

This phase adds a dedicated **Accounts Receivable view** — a single,
authoritative place answering "what do customers owe us, and how overdue is
it" — built entirely from data that already exists (`Invoice`, `Payment`).
No new database tables and no schema changes were needed; the only new file
is `src/lib/accounts-receivable.ts`, plus one new page
(`/finance/receivables`) and a route rename that both call it.

This is **not** a second, competing "finance" feature.
`src/lib/finance.ts` already has its own aging logic (`getFinanceSummary()`,
used by `/finance`) with a different purpose (a monthly cash-flow view
covering both money in and money out) and different bucket boundaries
(`notDue` / `1–30` / `31–60` / `over60`). That module is untouched by this
phase. The new `accounts-receivable.ts` module exists specifically for the
AR-only view this phase requires (0-30/31-60/61-90/90+ buckets, receivables
only, on-the-fly current/overdue classification) — see "Relationship to
`finance.ts`" below for why these are deliberately two different
calculations rather than one shared one.

## Status mapping (adapting to the existing enum)

The task's requirement lists `DRAFT, SENT, PARTIALLY_PAID, PAID, OVERDUE,
VOID, CANCELLED`. The actual Prisma `InvoiceStatus` enum is:

```prisma
enum InvoiceStatus {
  DRAFT
  SENT
  PARTIAL
  PAID
  OVERDUE
  CANCELLED
}
```

Per the explicit instruction to "adapt strictly to the existing
schema/enum architecture without inventing conflicting statuses," this
phase does **not** add new enum values. The mapping is:

| Requested concept | Existing enum value |
|---|---|
| DRAFT | `DRAFT` |
| SENT | `SENT` |
| PARTIALLY_PAID | `PARTIAL` |
| PAID | `PAID` |
| OVERDUE | `OVERDUE` |
| VOID | `CANCELLED` (the schema's only terminal non-payable state) |
| CANCELLED | `CANCELLED` |

There is no separate `VOID` status — `CANCELLED` already serves that role
(an invoice that will never be collected on), and adding a second value
with the same meaning would be exactly the kind of "conflicting status"
the task asked not to invent.

## Invoice lifecycle / status transition state machine

```
DRAFT ──(issued)──► SENT ──(partial payment)──► PARTIAL ──(fully paid)──► PAID
                      │                              │
                      ├──(past due, unpaid)──► OVERDUE ◄──(past due, still owing)
                      │                              │
                      └──(fully paid)──► PAID ◄───────┘
                      │
                      └──(cancelled)──► CANCELLED

Any of SENT / PARTIAL / OVERDUE ──(cancelled)──► CANCELLED
PAID and CANCELLED are terminal — nothing in this codebase transitions out of them.
```

- **DRAFT** and **CANCELLED** are manually-set, terminal-with-respect-to-this-logic
  states: nothing here ever overrides them. An invoice must be explicitly
  issued (leaving DRAFT) or explicitly cancelled — no automated process
  invents either transition.
- **SENT → PARTIAL** happens the moment any payment is recorded against an
  otherwise-unpaid invoice.
- **→ OVERDUE** happens when `dueDate` is in the past and the invoice isn't
  yet fully paid — this can happen from SENT or from PARTIAL. This
  document's "why current/overdue aren't read from status" section below
  explains why this is computed live rather than only relying on a
  scheduler.
- **→ PAID** happens the instant `amountPaid >= total`, from any of SENT,
  PARTIAL, or OVERDUE — a payment that fully covers an already-OVERDUE
  invoice moves it straight to PAID, never leaving it stuck as OVERDUE.
  Conversely, a *partial* payment against an OVERDUE invoice leaves it
  OVERDUE (not PARTIAL) — it's still both overdue and partially paid, and
  OVERDUE is the more urgent, more informative status to keep it in.
- A **refund** (Stripe or otherwise) that drops `amountPaid` back down runs
  the same rule in reverse — a fully-refunded PAID invoice on a still-future
  due date reverts to SENT; one past due reverts to OVERDUE.

### The one authoritative rule: `deriveInvoiceStatus()`

Before this phase, the "what status should this invoice have" decision was
implemented **three times**, independently, with subtly different logic:
the manual "record a payment" route, the Stripe webhook handler, and the
overdue-check scheduler. All three now call one function,
`deriveInvoiceStatus()` in `src/lib/accounts-receivable.ts`:

```ts
function deriveInvoiceStatus(input: { status, total, amountPaid, dueDate }, now = new Date()): InvoiceStatus {
  if (input.status === 'DRAFT' || input.status === 'CANCELLED') return input.status;
  if (input.total <= 0 || input.amountPaid >= input.total) return 'PAID';
  if (input.dueDate !== null && input.dueDate.getTime() < now.getTime()) return 'OVERDUE';
  return input.amountPaid > 0 ? 'PARTIAL' : 'SENT';
}
```

Precedence, top to bottom: **DRAFT/CANCELLED (untouched) → PAID → OVERDUE →
PARTIAL/SENT.** This one function is now called from:

- `src/app/api/invoices/[id]/payments/route.ts` — recording a manual
  payment (now also wrapped in a `prisma.$transaction` alongside the
  `Payment` create, closing a pre-existing gap where the two writes weren't
  atomic).
- `src/lib/stripe/webhook.ts` — `handlePaymentSucceeded()` and
  `handleChargeRefunded()` (replacing a local `computeInvoiceStatus()` that
  didn't know about `dueDate`/OVERDUE at all).
- `src/lib/automations/engine.ts` — `checkOverdueInvoices()`, which now
  re-derives status per invoice instead of unconditionally forcing
  `OVERDUE` on every row its query returns (a defense against the rare race
  where a payment lands between the query and the update loop — the
  scheduler can no longer move an already-fully-paid invoice backwards to
  OVERDUE).

## AR dashboard: summary metrics

`getAccountsReceivableDashboard()` fetches every `Invoice` of `type:
INVOICE` (excluding `ESTIMATE`/`RECEIPT` — those were never receivables to
begin with) whose status is one of `SENT`, `PARTIAL`, `OVERDUE`, or `PAID`
— i.e. every invoice that was ever actually issued. `DRAFT` and `CANCELLED`
are excluded entirely, at the query level, from every AR figure.

| Metric | Definition |
|---|---|
| **Total outstanding** | Sum of `balanceDue` over every open (`SENT`/`PARTIAL`/`OVERDUE`) invoice. |
| **Current** | Total outstanding, restricted to invoices whose `dueDate` is null or in the future. |
| **Overdue** | Total outstanding, restricted to invoices whose `dueDate` is in the past. |
| **Partially paid** | Balance due of open invoices that have *some* payment recorded (`amountPaid > 0`) — this overlaps with Current/Overdue by design; it's a different lens (has-a-payment) on the same open invoices, not a third partition. |
| **Paid** | Sum of `amountPaid` over `PAID` invoices. |

**`current + overdue == totalOutstanding` by construction** — every open
invoice falls into exactly one of the two, classified the same way
`aging` classifies invoices as overdue-or-not (see below).

### Why current/overdue aren't read from stored `status`

The scheduler (`checkOverdueInvoices()`) only runs on its own interval
(`AUTOMATIONS_INTERVAL_MINUTES`), so there's a window after an invoice's
`dueDate` passes where its stored `status` is still `SENT`/`PARTIAL` even
though it is, in fact, overdue. If the dashboard classified "current vs.
overdue" from `status`, it would be wrong for up to that whole interval.
Instead, `summarizeInvoicesForAR()` and `computeARAgingBuckets()` both
compare each invoice's own `dueDate` against "now" directly — the dashboard
is always accurate the instant you load it, independent of when the
scheduler last ran.

## AR aging buckets

`computeARAgingBuckets()` buckets the **balance due** (not the original
`total`) of every open, actually-overdue invoice by how many whole days
past its due date it is:

| Bucket | Days past due |
|---|---|
| 0–30 | `daysPastDue <= 30` |
| 31–60 | `31 <= daysPastDue <= 60` |
| 61–90 | `61 <= daysPastDue <= 90` |
| 90+ | `daysPastDue > 90` |

**Boundary inclusivity:** exactly 30 days late is `0-30`; exactly 31 is
`31-60`; exactly 60 is `31-60`; exactly 61 is `61-90`; exactly 90 is
`61-90`; exactly 91 is `90+`. Each bucket's upper edge belongs to that
bucket, not the next one — verified directly for every boundary in
`tests/accounts-receivable-calculations.test.ts`.

An invoice that is overdue but has since been **fully paid** contributes a
`balanceDue` of `0` and is excluded from aging entirely (it would otherwise
still show as "$0 in the 61-90 bucket," which is not useful). A
**partially**-paid overdue invoice ages by its remaining balance, not its
original total.

## Payment reconciliation & balance due

`computeBalanceDue(total, amountPaid)` is `max(0, total - amountPaid)`,
rounded to the cent. It is never negative — an overpayment (see
`docs/STRIPE_INTEGRATION.md` "Known limitations", which already documents
this same behavior for Stripe-originated payments) means the invoice owes
nothing further, not a negative balance owed to the customer. There is no
separate "overpaid" status; this matches the pre-existing manual-payment
route's behavior exactly.

## Verification, not silent trust

`verifyInvoiceFinancials(invoice, items, now)` is a read-only integrity
check: it recomputes `subtotal`/`taxTotal`/`discountTotal`/`total` from the
invoice's own line items using the exact same `computeTotals()` used when
an invoice is created or edited (`src/lib/totals.ts`), and flags any stored
value that has drifted by more than a cent. It also flags when the stored
`status` no longer matches what `deriveInvoiceStatus()` says it should be
right now — surfacing exactly the kind of drift a stale scheduler run, a
manual DB edit, or a bug elsewhere could otherwise leave invisible. This
function makes no writes; nothing calls it automatically today, but it's
available as the tool for auditing any existing invoice.

## Authorization

The AR dashboard (`/finance/receivables`) is gated the same way as the
existing `/finance` page: `requireModule('finance')`
(`src/lib/session.ts`), which redirects (`/dashboard?denied=1`) any role
without `finance` in `src/lib/permissions.ts`'s `MATRIX`. As of this phase,
that's `ADMIN` and `ACCOUNTING` — `SALES` and `OPERATIONS` cannot reach it,
matching the task's own phrasing ("Accounting/Admin access"). This is the
same coarse, existing module-level RBAC every other phase has reused, not
a new authorization mechanism.

## Relationship to `finance.ts`

| | `src/lib/finance.ts` (`/finance`) | `src/lib/accounts-receivable.ts` (`/finance/receivables`) |
|---|---|---|
| Purpose | Monthly cash-flow view: money in *and* out | Receivables-only: what's owed to us, and how overdue |
| Aging buckets | `notDue` / `1-30` / `31-60` / `over60` | `0-30` / `31-60` / `61-90` / `90+` (per this phase's explicit spec) |
| Scope | Both `Invoice` (receivable) and `SupplierInvoice` (payable) | `Invoice` (type `INVOICE`) only |

These are intentionally two separate, non-duplicating calculations serving
two different questions, not one figure computed twice — each pulls
directly from `Invoice`/`Payment` rows with no intermediate cached total,
so there is nothing for the two to disagree about even though their
bucket boundaries differ.

## Testing

- `tests/accounts-receivable-calculations.test.ts` — pure-function tests,
  no database: `deriveInvoiceStatus()` across every status transition
  (including the OVERDUE-then-fully-paid-returns-to-PAID and
  OVERDUE-then-partially-paid-stays-OVERDUE cases), `computeBalanceDue()`,
  `verifyInvoiceFinancials()`, `summarizeInvoicesForAR()`, and every aging
  bucket boundary (30/31/60/61/90/91 days).
- `tests/accounts-receivable-authorization.test.ts` — database-backed:
  confirms the dashboard aggregates real `Invoice`/`Payment` rows
  (excluding DRAFT, CANCELLED, and non-`INVOICE` types), that recording a
  payment changes the AR balance, and that `canAccess()` grants `finance`
  only to `ADMIN`/`ACCOUNTING`.
- `tests/stripe-webhook.test.ts` — all 9 pre-existing tests continue to
  pass unchanged after the webhook handlers were switched to
  `deriveInvoiceStatus()` (none of that file's fixtures set a `dueDate`,
  so behavior is identical to the old logic for every case it covers).

## Known limitations

- **No dunning/escalation logic** — this phase surfaces aging buckets; it
  doesn't add new automated reminder tiers beyond the pre-existing
  single overdue-invoice reminder in `checkOverdueInvoices()`.
- **Overpayment isn't specially flagged** on the AR dashboard, matching
  `docs/STRIPE_INTEGRATION.md`'s existing documented behavior for the same
  case.
- **No per-customer AR breakdown yet** — the dashboard is company-wide
  totals/aging only; a per-company view could reuse the same functions
  (they take a plain array of invoices) but isn't part of this phase's
  scope.
