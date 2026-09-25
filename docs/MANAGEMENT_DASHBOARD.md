# Management Dashboard

**Date:** 2026-09-25 (Phase 9)
**Status:** Implemented and tested. This document is the explicit behavior —
code should match this, not the other way around.

## What this is

The `/dashboard` page (`src/app/(app)/dashboard/page.tsx`) shows 15 real,
transactional KPIs plus three real-time activity streams — nothing
estimated, simulated, or hard-coded — assembled by `src/lib/dashboard.ts`'s
`getDashboardData(role, filters)`. It reuses Phase 5's
`getAccountsReceivableDashboard()` (built on the shared `deriveInvoiceStatus`
precedence rules) and Phase 6's `getProductCostMap()`/
`computeLineProfitability()`/`summarizeProfitability()` rather than
re-deriving revenue/cost/status logic a second time, so this dashboard can
never disagree with `/finance/receivables` or `/finance/profitability`
about what a dollar of revenue, an overdue invoice, or a resolved product
cost is.

**Active sales channels: WooCommerce/Website and Direct only.** These are
the only two values `SalesOrder.externalSource` ever takes in this schema
(`'woocommerce'` for synced orders, `null` for manually-entered ones).
There is no Amazon, Walmart, or TikTok column anywhere in this schema, so
there is nothing to filter by for those — this is a deliberate scope
boundary (matching `docs/PROFITABILITY_REPORTING.md`), not an oversight,
and adding them later means adding the column first, not inventing a value
here.

## Data sources and Prisma queries, per KPI

Every KPI below is computed by exactly one query (or one query pair, where
a KPI needs the shared product-cost map) — see "Query optimization
patterns" for why. Line numbers refer to `src/lib/dashboard.ts`.

| # | KPI | Query | Definition |
|---|---|---|---|
| 1–3 | Sales Today / This Month / This Year | `fetchRawOrderLines()`: one `prisma.salesOrder.findMany({ where: { status: { in: STOCK_HOLDING_STATUSES }, createdAt: { gte: rangeStart }, ... }, select: { items: { select: {...} } } })` | Σ `quantity*unitPrice - discount` over lines whose order is `CONFIRMED`/`SHIPPED`/`DELIVERED` (the same "actually sold" set `checkLowStock`/Profitability use) and whose `createdAt` falls in that fixed calendar window. Computed in JS from one shared result set (`computeSalesFigures`) — see below. |
| 4 | Outstanding Invoices | `getAccountsReceivableDashboard(now, companyId)` → one `prisma.invoice.findMany({ where: { type: 'INVOICE', status: { in: [...OPEN_STATUSES, 'PAID'] } } })` | `summary.totalOutstanding` — every `SENT`/`PARTIAL`/`OVERDUE` invoice's balance due, classified by the shared `deriveInvoiceStatus` precedence (PAID > OVERDUE > PARTIAL/SENT). |
| 5 | Overdue Invoices | Same query as #4 | `summary.overdue` — the subset of outstanding invoices whose `dueDate` has passed, computed directly from `dueDate` (not from stored `status`) so it's accurate even in the window before the overdue-check scheduler tick catches up — see `docs/ACCOUNTS_RECEIVABLE.md`. |
| 6 | Total Inventory Value | `loadInventorySnapshot()`: one `prisma.stockLevel.findMany({ include: productVariant.product, warehouse })`, scored against `getProductCostMap()` | Σ `quantity * unitCost` over tracked-inventory stock levels with a resolvable cost. A product with no resolvable cost is never coerced to $0 — see "Inventory value never guesses a cost" below. |
| 7 | Low-stock products (count + list) | Same `stockLevel.findMany` as #6 | `quantity <= product.reorderPoint AND trackInventory` — identical to `checkLowStock()` in `src/lib/automations/engine.ts`, so this dashboard and the automation that emails/flags low stock never disagree. |
| 8 | Open Quotes | `loadOpenDocuments()`: `prisma.quote.aggregate({ where: { status: { in: ['DRAFT','SENT'] } }, _count, _sum: { total } })` | Quotes not yet accepted/declined/expired — draft or sent. |
| 9 | Open Sales Orders | `prisma.salesOrder.aggregate({ where: { status: { in: ['DRAFT','CONFIRMED','SHIPPED'] } }, _count, _sum: { total } })` | Orders not yet fully fulfilled (excludes `DELIVERED`) and not cancelled — "pending fulfillment/shipping." |
| 10 | Open Purchase Orders | `prisma.purchaseOrder.aggregate({ where: { status: { in: ['DRAFT','SENT','PARTIALLY_RECEIVED'] } }, _count, _sum: { total } })` | Exactly `status != RECEIVED AND status != CANCELLED` (`PurchaseOrderStatus` only has those 5 values, so this `in` list and that `!=` phrasing are the same set). |
| 11–12 | Gross Profit / Gross Margin % | Same `fetchRawOrderLines()` result as #1–3, scored via `computeLineProfitability`/`summarizeProfitability` against `getProductCostMap()` | Revenue − known COGS, and margin = grossProfit/revenue. Finance-role-gated — see "Role-based visibility." |
| 13 | Recent Orders | `prisma.salesOrder.findMany({ orderBy: { createdAt: 'desc' }, take: 10, include: { company } })` | Last 10 orders: id, number, date, customer, status, total, channel. |
| 14 | Recent Payments | `prisma.payment.findMany({ orderBy: { paidAt: 'desc' }, take: 10, include: { invoice: { company } } })` | Last 10 payments: id, date, invoice number, customer, method, amount. |
| 15 | Recent Inventory Movements | `prisma.stockMovement.findMany({ orderBy: { createdAt: 'desc' }, take: 10, include: { productVariant.product, warehouse } })` | Last 10 movements: timestamp, product/SKU/variant, warehouse, type, quantity change, and `referenceType`/`referenceId` (what caused it — e.g. a shipment or goods receipt). |

## Which filters apply to which KPI

The task asked for customer/product/warehouse/channel filtering "where
relationships exist." This schema-driven table is that boundary, made
explicit:

| Filter | Applies to | Does not apply to (why) |
|---|---|---|
| Customer | Sales figures, gross profit/margin, AR figures, open quotes/orders, recent orders/payments | Open purchase orders, inventory value, low stock, recent inventory movements (all supplier/warehouse-side, no customer dimension) |
| Product | Sales figures, gross profit/margin, inventory value, low stock, recent inventory movements | Open quotes/orders/POs, AR figures, recent payments (no product dimension on those documents) |
| Warehouse | Inventory value, low stock, recent inventory movements | Everything sales/invoice-side — `SalesOrderItem`/`Invoice` have no warehouse dimension in this schema |
| Sales channel | Sales figures, gross profit/margin, open sales orders, recent orders | Invoices, quotes, purchase orders, inventory (no channel dimension there) |
| Date range (presets: Today / This Month / This Year, or a custom range) | Gross profit/margin, recent orders/payments/movements | Sales today/this month/this year (always their own fixed period, by definition, independent of the date-range filter) and every current-state figure (Outstanding/Overdue, Inventory value, Low-stock, Open quotes/orders/POs) — see below |

The date-range **presets** (Today / This Month / This Year) are convenience
links that pre-fill the same `from`/`to` query params the custom-range
inputs use — there is no separate code path, so a preset and a manually
typed matching range always produce identical results.

### Why the date range never changes a "current state" figure

Outstanding/Overdue invoices, Inventory value, Low-stock, and Open
quotes/orders/POs are all *as-of-right-now* snapshots. Reconstructing "what
was outstanding/in stock/open as of a past date" isn't supported by this
schema (no historical AR-balance or stock-level ledger to replay), and
faking it from today's data would risk quietly fabricating a number — which
the task explicitly forbids. The date range instead scopes the two KPIs
where a historical range is both meaningful and actually computable: Gross
profit/margin (derived from `SalesOrder.createdAt`) and the "recent" lists.

### Inventory value never guesses a cost

`getProductCostMap()` resolves cost per product in the same
purchase-history → standard-cost → unknown priority order documented in
`docs/PROFITABILITY_REPORTING.md`. A tracked-inventory product with no
resolvable cost is never treated as $0 — its on-hand units are counted
separately as `unknownCostUnits`/`unknownCostProductCount`, and
`hasUnknownCost` tells the UI to show "$X known + Y units of unknown
value" instead of a false, understated total. The same honesty rule
applies to Gross Profit/Margin: `hasUnknownCost` there means the figures
shown are a floor ("at least $X"), not a final number.

## Role-based visibility

Gross profit and Gross margin — and Inventory value, since it's cost-based
— are only computed and returned when the viewing role has `finance` module
access (ADMIN/ACCOUNTING; see `src/lib/permissions.ts`), mirroring the same
gate `/finance/profitability` and `/finance/receivables` already use. For
any other role, `getDashboardData()` returns `grossProfit: null` and
`inventoryValue: null` — the page simply omits those cards — and,
defense-in-depth, the product cost map is never even fetched for a
non-finance role, so no cost data is queried let alone rendered. Every other
KPI (sales totals, receivables balances, open documents, low stock, recent
activity) stays visible to every role with `dashboard` module access (all
roles today), matching the original dashboard's visibility.

## Query optimization patterns applied

Every section runs as exactly one query (or one query pair for a shared
cost-map lookup), never a per-row query — verified by
`tests/dashboard.test.ts`'s "query efficiency (no N+1)" suite, which asserts
the query count for one `getDashboardData()` call stays flat as the
underlying order/item count grows:

- **Sales figures + gross profit** share a single `SalesOrder.findMany`
  (`fetchRawOrderLines`), widened to cover both the fixed year-to-date range
  and any custom date filter, so today/month/year/gross-profit can never
  drift from each other — the same "one query, several views" discipline
  `docs/PROFITABILITY_REPORTING.md`'s `fetchScoredOrderLines` established.
- **Inventory value + low stock** share one `StockLevel.findMany` and reuse
  the cost map already fetched for gross profit — no second cost query.
- **Open quotes/orders/POs** run as three `aggregate()` calls (DB-side
  count+sum), not a fetch-then-reduce in application code.
- **Recent orders/payments/movements** each run as one `findMany` with a
  relational `select`/`include`, never a per-row follow-up query for the
  company/invoice/product/warehouse name.
- All independent sections (sales lines, cost map, receivables, open
  documents, recent activity) run concurrently via `Promise.all`, not
  sequentially.

## Filters that don't change business data

The dashboard is entirely read-only. `getDashboardFilterOptions()`
(customer/product/warehouse dropdown lists) and `getDashboardData()` never
write anything — they only shape `WHERE` clauses over real, existing rows.
Nothing in this phase touches production data, migrations, or deployment.
