# System Hardening (Phase 8)

**Date:** 2026-09-25 (Phase 8)
**Status:** Implemented and tested. This document is the explicit behavior —
code should match this, not the other way around.

## What this is

This phase closes the highest-value items still open in `docs/SYSTEM_AUDIT.md`
after Phases 0–7 (which already resolved C1–C5, D2, D3, E4, and the
negative-stock gap — see that document's own findings for what those were).
Six items, scoped tightly the same way every "stop the bleeding" phase in
this project has been:

| Finding | What it was | What changed |
|---|---|---|
| **D1** | Document numbering (`generateNumber()`) was `count() + 1` with no locking — two concurrent creates could compute the same number, and the loser hit a raw, unhandled `P2002`. | Transaction + advisory-lock guarded, and properly year-scoped (see F2 below). |
| **D4** | Two (really three, once the manual/Cron route is counted) independent triggers could all run an automations tick at once, with nothing stopping them from overlapping. | A shared, database-backed exclusive lease all three triggers now go through. |
| **D5** | `bills/[id]/approve`'s BILL path did up to four separate, unguarded writes (find/create supplier, create invoice, create payment, update entry). | Wrapped in one transaction. |
| **D7** | 4 `npm audit` findings (1 critical, 3 high), including — newly surfaced during this phase's own re-check — critical Next.js image-optimizer RCE/DoS advisories the original audit's snapshot didn't have visibility into. | Explicitly triaged (not blind-fixed); the one live, zero-risk mitigation available today was applied. |
| **E1** | CSV export didn't neutralize formula-injection trigger characters. | Fixed. |
| **E3** | `/api/health` returned the raw database error message to any unauthenticated caller. | Fixed. |

## D1 — Numbering race and year-scoping

### The race

`src/lib/numbering.ts`'s `generateNumber()` computed `COUNT(*) + 1` with no
lock of any kind. Two concurrent requests creating the same kind of
document (e.g. two quotes submitted at the same moment) could both read
the same count, both compute the identical number, and the second write
would fail with an unhandled Prisma `P2002` — a raw 500 with no
explanation, on a table where every document number is `@unique`.

### The fix

`generateNumber(kind, db)` now **requires** its caller to pass a `db` — a
`tx` from an enclosing `prisma.$transaction(async (tx) => ...)` — and,
inside that transaction, does:

```sql
SELECT pg_advisory_xact_lock(hashtext('number:<kind>:<year>'))
```

before counting. This is the same `pg_advisory_xact_lock`-inside-a-
transaction pattern already used throughout this codebase (goods
receiving, sales-order status transitions, purchase-order lifecycle
transitions). The lock is scoped to `kind` + calendar year, so generating
an invoice number never blocks generating a purchase-order number, and a
year rollover doesn't block anything either.

**The critical part of the contract**: the record that number is *for*
must be created inside that *same* transaction, before it commits. The
lock only actually prevents a duplicate if the row that makes the next
count go up is itself committed before the next caller is allowed to
count — a lock that's released before the row exists doesn't protect
anything. Every call site was updated to wrap number generation and
record creation together:

- `src/app/api/quotes/route.ts`, `src/app/api/purchase-orders/route.ts`,
  `src/app/api/invoices/route.ts`, `src/app/api/quotes/[id]/convert/route.ts`
  — each now wraps its `generateNumber()` + `create()` call in one
  `prisma.$transaction`.
- `createSalesOrderWithInventoryEffect()` and `createInvoiceForSalesOrder()`
  (`src/lib/sales-orders.ts`) already had their own enclosing transaction
  (for their inventory-effect / invoice-idempotency logic) — they now
  generate their number *inside* that same transaction instead of before
  it, closing what would otherwise still have been a gap.

### F2 — year-scoping (a second, previously undetected bug in the same function)

The original `count()` query had **no date filter at all** — the sequence
number climbed forever across years instead of resetting each January,
contradicting the function's own "year-scoped" doc comment. Fixed in the
same change: the count is now scoped to
`[Jan 1 00:00:00, Jan 1 00:00:00 next year)` of the current year.

### Testing

`tests/numbering.test.ts`: correct format; 15 genuinely concurrent calls
for the same kind never collide (the core regression test); different
kinds never contend with each other; a backdated prior-year row never
inflates this year's sequence.

## D4 — the dual/triple-scheduler race

### The gap

Three independent code paths could all run "the automations pass + sync
every active email account": the in-process scheduler
(`src/instrumentation-node.ts`, always on inside the `app` container), the
optional standalone `worker` process (`src/worker/index.ts` /
`docker-compose.yml`, documented as an alternative to the in-process
scheduler but not currently deployed on Easypanel), and the manual/
Cron-triggered `POST /api/automations/run` route. Nothing stopped any two
of these from running at the same time — the audit's own framing was "one
Easypanel service addition away from silently duplicating every automated
invoice-overdue reminder and order-confirmation email."

### The fix

`src/lib/automations/tick-lock.ts` — `runAutomationsTickExclusive()` is
now the single entry point all three triggers call. It claims a shared,
database-backed lease (`ScheduledTickLock`, a new, purely additive table —
migration `20260925020000_scheduled_tick_lock`) before doing any real
work, and is a clean no-op (`ranTick: false`) if another process already
holds it.

**The claim itself is a plain `INSERT` keyed by a fixed id**, not a
conditional `UPDATE` or a bare advisory lock. Two concurrent attempts to
`create()` the same primary key is exactly the scenario Postgres's
primary-key uniqueness constraint exists to make airtight — at most one
`INSERT` ever succeeds, full stop, with no dependency on isolation levels
or connection pooling behavior. (A conditional-`UPDATE` compare-and-swap
and a `pg_advisory_xact_lock`-guarded version were both built and tested
during this phase before settling on the plain-`INSERT` design — see
"What this ISN'T" below for why.) Releasing the lease **deletes** the row
— "free" is "no row exists," not "a row with `lockedAt: null`." Reclaiming
an *abandoned* lease (the row exists, but is older than `LEASE_MINUTES` =
10 — the process that created it crashed without releasing it) is the one
remaining path that needs a conditional `UPDATE ... WHERE lockedAt <
staleBefore`; that path is inherently rare and non-hot, so it doesn't need
the same airtight treatment as the common "claim a free lease" path.

`src/instrumentation-node.ts`, `src/worker/index.ts`, and
`src/app/api/automations/run/route.ts` were all rewritten to call
`runAutomationsTickExclusive()` instead of each independently duplicating
the "run automations, then loop over active email accounts" logic — this
was also a straightforward de-duplication of three near-identical
implementations into one.

### What this isn't (and what "exactly one at a time" actually means)

The lease guarantees **no two ticks' actual work ever runs at the same
instant** — it does not (and was never meant to) guarantee "only one tick
ever runs within some rough time window." If tick A's work is fast and it
releases the lease quickly, a tick B that started at nearly the same
moment but was still waiting on I/O (e.g. queued behind A for a database
connection) can legitimately claim the lease immediately after and run —
that's two closely-spaced ticks, not two *simultaneous* ones, and it's
correct, harmless behavior (`runScheduledAutomations()` and
`syncEmailAccount()` are both already idempotent/safe to run back-to-back
— see `docs/INVENTORY_RULES.md` and the existing `AutomationLog`/`Task`
dedup logic). This distinction is exactly why
`tests/automations-tick-lock.test.ts`'s concurrency tests inject an
artificially slow stand-in for the tick's real work (via the optional
`work` parameter `runAutomationsTickExclusive()` exposes, used only in
tests) — without a deliberately widened work window, two calls fired at
the same JS-level instant against a near-empty test database can
legitimately both succeed sequentially in a few milliseconds, which is
correct but doesn't exercise genuine contention.

### Testing

`tests/automations-tick-lock.test.ts`: a single call claims and runs;
the lease is released after success so a later call can claim again;
two and eight genuinely-overlapping calls (via the slow-work injection) —
exactly one ever runs, every other run is a clean no-op with no `results`;
a stale/abandoned lease is reclaimed; a fresh lease is not; two
*sequential* (non-overlapping) calls both succeed, confirming the lock
only prevents simultaneous holders, not closely-spaced ones.

## D5 — bill-approval transaction

### The gap

`bills/[id]/approve`'s BILL path (turning a reviewed `BillEntry` into a
real `SupplierInvoice`) did up to four separate, unguarded writes: find-or-
create the supplier `Company`, create the `SupplierInvoice`, optionally
create a `SupplierPayment`, then update the `BillEntry`. A crash or
connection drop between any of these — or a duplicate invoice number
failing the *second* write — could leave a bill recorded as unpaid when it
was actually paid, a payment row with no matching invoice, a `BillEntry`
stuck in `REVIEW` after its bill had already been created, or (in the
duplicate-number case specifically) a brand-new supplier `Company` created
and then never linked to anything, orphaned by the failed second write.

### The fix

Extracted into `approveBillEntryAsBill()` (`src/lib/supplier-invoices.ts`)
— the same "logic lives in `src/lib`, the route is a thin wrapper" pattern
already used for every other multi-write operation in this codebase
(`receiveGoodsForPurchaseOrder`, `transitionSalesOrderStatus`,
`createInvoiceForSalesOrder`) — wrapping the find/create supplier, create
invoice, optional create payment, and update entry all in one
`prisma.$transaction`. A duplicate invoice number now rolls back
*everything*, including the supplier lookup/create step: retrying with a
corrected number never finds an orphaned duplicate `Company` left over
from the failed attempt.

### Testing

`tests/bill-approval-transaction.test.ts`: unpaid-bill approval (no
payment row created); already-paid approval (invoice + payment created
together); reuses an existing supplier by case-insensitive name match
instead of duplicating it; **the core regression test** — a duplicate
invoice number rolls back the entire transaction, leaving no orphan
supplier `Company`, no orphan payment, and the `BillEntry` still `REVIEW`
and retryable; retrying with a corrected number succeeds cleanly with
exactly one supplier `Company` (not two).

## D7 — dependency vulnerability triage

Re-running `npm audit --production` during this phase surfaced **more**
than the original audit recorded: alongside the previously-known
nodemailer chain (via `next-auth`) and the PostCSS chain (via `next`), the
`next` package's own advisory set now includes a long list of CVEs —
critically, an **unauthenticated Remote Code Execution in the Image
Optimization API when AVIF files are used**, and an unauthenticated RCE
specific to Windows-hosted servers. Both trace to `next` itself (current
version 14.2.35), not just to a build-time-only dependency, which is more
severe than the original audit's "PostCSS XSS/path-traversal, build-time
only" characterization — either these advisories were published after the
2026-09-22 audit date, or the original snapshot didn't surface them; this
document supersedes that characterization with what's actually current.

### Why this phase does not run `npm audit fix --force`

Per the original audit's own explicit caution, and confirmed again here:
`npm audit fix --force` would bump `next` from `14.2.35` straight to
`16.3.6` — skipping major version 15 entirely — and `nodemailer` to
`10.0.10`, a breaking major version jump from `7.x`. A Next.js major-
version bump on a 70+ route production application, attempted
unsupervised inside an autonomous phase, is exactly the kind of change
that needs a dedicated, explicitly-scoped upgrade phase with real
regression testing — not something to fold into a hardening pass.
**Not performed in this phase; still open, and should be its own
future phase.**

### What was fixed: disabling the live, zero-risk attack surface

Nothing in this application actually uses `next/image` anywhere — but
Next.js's built-in Image Optimization API (`/_next/image`) is **on by
default regardless**, and it's excluded from `middleware.ts`'s auth gate
(it has to be — it needs to serve images referenced from public pages).
That makes it a live, unauthenticated attack surface for the AVIF-related
RCE/DoS advisories above, on production, right now, with zero legitimate
traffic depending on it. `next.config.mjs` now sets
`images: { unoptimized: true }`, which disables that endpoint entirely.
This is a config-only change with no functional impact (confirmed: no
`next/image` import anywhere in `src/`) and closes the most severe part of
D7 without touching any dependency version.

### App's own nodemailer usage — checked, not just assumed

The app's direct `nodemailer` usage (`src/lib/email/smtp.ts`) was checked
against the specific advisory list: no `name`/`localAddress` transport
option (rules out the EHLO/HELO CRLF injection advisory), no
`jsonTransport`, no OAuth2 auth (rules out the OAuth2 TLS-validation
advisory — auth here is plain user/password), no `raw` message option, no
legacy `resolveContent()` signature. The IDN/punycode recipient-domain and
IDN allow-list-bypass advisories remain a real, unresolved gap *in
principle* (`to:` addresses do include customer-supplied email addresses,
e.g. for order confirmations) — mitigating those specifically requires the
nodemailer major-version bump this phase deliberately defers.

### Recorded decision: pin and monitor

Per the original audit's own framing ("pin and monitor" vs. "upgrade now")
— **pin and monitor** is the explicit decision for this phase. The
`/_next/image` mitigation above closes the one part of this that was both
severe and free to fix; the rest requires a scoped major-version-upgrade
phase with real regression testing, not an unsupervised autonomous change.

## E1 — CSV export formula injection

`src/lib/csv.ts`'s `toCsv()` now prefixes any cell whose text starts with
`=`, `+`, `-`, `@`, tab, or carriage return (OWASP's CSV-injection trigger
list) with a literal `'` — the standard "force text" prefix Excel/Sheets/
Numbers all respect, never rendered in the cell itself. Applies to every
CSV export in the app (invoices, sales orders, and any future export)
automatically, since they all go through this one function. A normal
value that merely *contains* one of those characters mid-string (e.g.
"Acme + Co") is untouched — only a leading trigger character is
neutralized.

**Tested** in `tests/csv-export-injection.test.ts`: each trigger character
neutralized; normal values unaffected; still correctly quotes when the
neutralized value also needs comma/quote escaping; null/undefined render
as empty cells, not literal "null"/"undefined" strings.

## E3 — health endpoint no longer leaks internals

`/api/health` is unauthenticated by design (needed for uptime checks), so
a database-check failure's detail — which can include connection strings,
internal hostnames, or driver internals — is now logged server-side only
(`console.error`) and never included in the public JSON response. The
response still correctly reports `status: "error"` / `database:
"unreachable"` with a `503`, just without the raw error text.

## Testing summary

- `tests/numbering.test.ts` (new) — D1/F2.
- `tests/automations-tick-lock.test.ts` (new) — D4.
- `tests/bill-approval-transaction.test.ts` (new) — D5.
- `tests/csv-export-injection.test.ts` (new) — E1.
- `tests/inventory-hardening.test.ts` (updated) — one call site updated
  for `createSalesOrderWithInventoryEffect()`'s new signature (number is
  now generated internally, not passed in).

## Known limitations / deferred work

- **D7's dependency upgrade is deferred**, not fixed — see above. This is
  the single most important follow-up from this phase: schedule a
  dedicated Next.js/next-auth major-version upgrade phase with real
  regression testing.
- **D6** (migrations applied manually, not automated in the Docker
  image's `CMD`) is a deployment-process concern, not a code change, and
  is unchanged by this phase.
- **The standalone `worker` process is still not deployed** on Easypanel
  (unchanged) — D4's fix means it would now be *safe* to deploy alongside
  the in-process scheduler if ever wanted, but this phase doesn't change
  which services are actually running in production.
