# Customer 360 View

**Date:** 2026-09-23 (Phase 3)
**Status:** Implemented and tested. This document is the explicit
architecture and calculation logic — code should match this, not the
other way around.

## What this is

A single page (`/companies/[id]`, `src/app/(app)/companies/[id]/page.tsx`)
that brings together everything the CRM already knows about one company:
profile, contacts, sales orders, quotes, opportunities, invoices, payments,
products purchased, purchase orders (when the company is a supplier),
tasks, notes, documents, and communication history (WhatsApp, email,
logged calls/meetings). It does not introduce a new data model — every
field shown is read from tables that already existed before this phase.

## Architecture

All data-fetching and calculation lives in one library module,
[`src/lib/customer-360.ts`](../src/lib/customer-360.ts), exporting a single
entry point:

```ts
getCustomer360(companyId: string, role: Role): Promise<Customer360Data>
```

The page (`companies/[id]/page.tsx`) calls this once and renders whatever
comes back — it contains no Prisma queries and no authorization logic of
its own. This mirrors the rest of the codebase's established pattern
(`transitionSalesOrderStatus`, `receiveGoodsForPurchaseOrder`,
`syncWooCommerce`, etc.): business logic in `src/lib`, thin
routes/pages on top, and that's what makes the logic unit-testable without
a browser (`tests/customer-360-financials.test.ts`,
`tests/customer-360-authorization.test.ts`).

## Authorization: sections, not a new permission system

`getCustomer360Sections(role)` maps a `Role` to which sections it may see,
using the **existing** module-access matrix in `src/lib/permissions.ts` —
no new permission concept was introduced, per instruction not to redesign
the app:

| Section | Gated by module | Contains |
|---|---|---|
| Sales | `sales` | Sales orders, quotes, opportunities, products purchased |
| Invoicing | `invoicing` | Invoices, payments, financial summary |
| Purchasing | `purchasing` | Purchase orders (company as supplier) |
| Tasks | `tasks` | Tasks linked to this company |
| WhatsApp | `whatsapp` | WhatsApp message history |
| Inbox | `inbox` | Recent emails |

Profile, address, contact details, contacts list, notes, documents, and
communication-log history have no dedicated module in the access matrix
(same as before this phase) and are shown to anyone who can open the page
at all (gated by `companies`, checked once by the page via
`requireModule('companies')` before `getCustomer360` is ever called).

**The boundary is enforced by never issuing the query, not by hiding
already-fetched data in the UI.** `getCustomer360` only calls
`prisma.invoice.findMany(...)` (etc.) for a section if
`getCustomer360Sections(role)` says that section is visible — a role
without `invoicing` access never has invoice rows leave the database for
this page, regardless of what the UI does with them. The page renders a
"Your role doesn't have access to this information" card in place of any
section that came back `null`, so the layout stays predictable instead of
sections silently vanishing.

This is tested directly in `tests/customer-360-authorization.test.ts`:
each test seeds a company with real rows in every section, requests the
data as a role that shouldn't see one of them, and asserts both that the
section came back `null` *and* that the underlying row still genuinely
exists (i.e. it's a real access-boundary test, not a false negative from
forgetting to seed the data).

## Financial aggregation logic

Two figures are shown: **total sales**, **total paid**, and **outstanding
balance** — computed by `computeCustomerFinancialSummary()`, a pure
function over a company's `Invoice` rows (no I/O, easily unit-tested in
`tests/customer-360-financials.test.ts`).

- **Included invoice statuses:** `SENT`, `PARTIAL`, `PAID`, `OVERDUE`.
  `DRAFT` invoices are excluded (not yet issued — not a real sale yet).
  `CANCELLED` invoices are excluded (never actually billed).
- **`totalSales`** = sum of `total` across included invoices.
- **`totalPaid`** = sum of `amountPaid` across included invoices.
- **`totalOutstanding`** = sum of `(total - amountPaid)`, but only across
  `SENT`/`PARTIAL`/`OVERDUE` invoices — a fully `PAID` invoice contributes
  to `totalSales`/`totalPaid` but never to the outstanding balance.

**Every figure is read from each invoice's own already-authoritative
`total`/`amountPaid` fields** (maintained elsewhere by `computeTotals()` at
invoice-write time and by payment recording) — **never** re-derived by
summing `InvoiceItem` rows independently. Doing the latter would give the
same number two separate, potentially-drifting sources of truth, which is
exactly the "duplicate financial data" this phase was told to avoid.

**Products purchased** works the same way in spirit but necessarily reads
line items (there's no product-level total anywhere else to reuse):
`SalesOrderItem` rows across the company's non-`CANCELLED` sales orders
are grouped by product, summing `quantity` and `(unitPrice × quantity) -
discount` per line — using each line's own stored values, not a
recomputed price.

## Activity and "customer status"

`activity.lastActivityAt` is the most recent timestamp across every
section the *requesting role* can see (notes, documents, communication
log, and — only if visible to that role — sales orders, quotes,
opportunities, invoices, payments, purchase orders, tasks, WhatsApp
messages). `activity.status` is a simple, deliberately unsophisticated
heuristic: `active` if the most recent of those is within 90 days,
`inactive` if older, `no_activity` if there's nothing at all. This is not
a business-tuned scoring model — it's the minimum useful signal, and it's
documented as a starting point, not a finished feature, if the business
wants something more specific later (e.g. weighted by deal size, or
different thresholds per company type).

Because the timestamp pool is restricted to what the role can see, a
role's read of "last activity" never leaks that *something* (e.g. a new
invoice) happened via a timing signal alone, even without seeing the
invoice itself.

## UI states

- **Loading:** `companies/[id]/loading.tsx` — a static skeleton shown
  automatically by Next.js while the page's data is being fetched (the App
  Router's built-in `loading.tsx` convention; no client-side spinner logic
  needed).
- **Empty:** every section renders its own empty state ("No invoices yet.",
  "No purchase history yet.", etc.) rather than an empty list with no
  explanation — unchanged from the pre-Phase-3 page's existing pattern,
  extended to the new sections.
- **Not found:** an unknown company id still resolves to Next.js's regular
  `notFound()` → 404 page (`getCustomer360` throws a typed
  `CompanyNotFoundError`, which the page catches specifically and converts
  to `notFound()`; any other error is rethrown, not swallowed).
- **Error:** `companies/[id]/error.tsx` — Next.js's `error.tsx` boundary
  convention catches anything else that goes wrong while rendering this
  page (a database hiccup, an unexpected exception) and shows a plain
  "couldn't load this customer" message with a retry button, instead of
  the whole app crashing to a blank screen.

## What this phase deliberately did not do

- **No new external integrations** — every data source was already
  integrated (email, WhatsApp, WooCommerce-synced sales, etc.); this phase
  only reads and aggregates.
- **No new permission model** — reuses the existing module matrix exactly
  as-is.
- **No schema changes, no migration** — every field rendered already
  existed.
- **No row-level/per-company ownership enforcement** — the existing
  authorization model is module-level only (any user with `sales` access
  can see *any* company's sales data, not just companies they own); this
  phase enforces the same module boundary the rest of the app already
  uses, and does not attempt to add row-level/ownership-based restriction,
  which would be a materially larger change to the authorization model
  than this phase's scope (`docs/SYSTEM_AUDIT.md`, section H, already
  flags this as a known, intentional simplification for a small team).
- **WooCommerce-sourced sales orders/products** show up in "Sales orders"
  and "Products purchased" exactly like CRM-native ones — no special
  casing was needed, since they're already ordinary `SalesOrder`/
  `SalesOrderItem` rows (see `docs/WOOCOMMERCE_INTEGRATION.md`).
