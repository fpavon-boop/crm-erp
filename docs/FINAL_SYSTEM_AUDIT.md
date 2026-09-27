# Final Comprehensive System Audit

**Date:** 2026-09-27
**Status:** Read-only audit. No production database was touched, nothing
was deployed, and no fixes were applied in this pass (see "Scope" below) —
this document records findings for a follow-up prioritization decision.

## Scope

Ten areas were reviewed for duplicate records/movements, race conditions,
N+1 queries, missing indexes, and financial math accuracy: Inventory,
WooCommerce, CRM, Orders, Invoices, Stripe, Automations, AI, Security, and
the new sales-channel abstraction (`docs/SALES_CHANNEL_ARCHITECTURE.md`).
Security is **not** re-audited here — it was already covered by a dedicated
pass the same day; see `docs/SECURITY_AUDIT.md` for that report in full.
This document is the correctness/performance/data-integrity companion to
it.

## Headline findings

| # | Severity | Area | Finding |
|---|---|---|---|
| 1 | **HIGH** | Orders | `quotes/[id]/convert` has no guard against double-conversion — two concurrent requests (two tabs, a retried click) can create two `SalesOrder`s from one `Quote`, each independently invoiceable and inventory-affecting |
| 2 | **HIGH** | Invoices/Stripe | Manual payment recording, the Stripe webhook, and the WooCommerce payment-sync path all compute `Invoice.amountPaid` as `read → add in JS → write` with no row lock — two payments landing close together can lose one's effect on `amountPaid`/`status` (the `Payment` rows themselves are both saved correctly; only the invoice's running total is wrong) |
| 3 | **HIGH** | Inventory | The "Adjustment" stock-movement type is always treated as a positive delta — a user recording a downward stocktake correction via "Adjustment" has stock *added*, not subtracted, with no warning |
| 4 | MEDIUM-HIGH | Invoices | Manual-payment idempotency (`idempotencyKey`) exists in the API but the only UI caller never sends it — the double-submit protection is dead code |
| 5 | MEDIUM-HIGH | CRM/Orders | Several foreign-key columns hit on hot paths (`Quote`/`SalesOrder`/`PurchaseOrder`/`Invoice` company/contact/quote/salesOrder ids) have no index — Postgres does not auto-index FKs |
| 6 | MEDIUM | Inventory | Manual stock-adjustment idempotency key exists in the API but the only UI caller never sends it (same dead-code pattern as #4, different feature) |
| 7 | MEDIUM | Invoices | `PUT /api/invoices/[id]` never re-derives `status` after an edit changes the total — an edited-down invoice can be left in a stale status |
| 8 | MEDIUM | Invoices | `computeTotals()`'s `total` is derived from unrounded accumulators while `subtotal`/`taxTotal`/`discountTotal` are each rounded independently — the printed total can be $0.01 off from summing the printed line items |
| 9 | MEDIUM | Automations | The overdue-invoice reminder job re-fetches each invoice's relations one at a time inside its loop instead of including them in the initial query (N+1) |
| 10 | MEDIUM | Automations | Outbound WhatsApp automation actions (`send_whatsapp_template`) have no idempotency guard, unlike every other outbound-message path in the app |
| 11 | MEDIUM | Automations | A payment reminder that fails to send (e.g. SMTP down) is never retried — the created `Task` silently blocks all future attempts |
| 12 | LOW-MEDIUM | Inventory | WooCommerce stock sync computes its delta from a point-in-time read; a concurrent internal sale inside that window can cause a small, self-correcting drift from Woo's authoritative quantity |
| 13 | LOW-MEDIUM | CRM | `Contact.email` has no unique constraint or index; the WooCommerce customer-dedup race is only narrowed (documented in-code), not eliminated, and the in-process sync lock doesn't hold across multiple app instances |
| — | — | Channel abstraction | Confirmed fully isolated and inert — see item 10 below |
| — | — | AI | Re-verified: FACTS builders remain pure code, AI failures still degrade to `aiAvailable:false` with facts intact — no regressions |
| — | — | Security | See `docs/SECURITY_AUDIT.md` (separate, same-day pass) |

Full detail for each numbered area follows.

---

## 1. Inventory

**Confirmed bugs:**
- **[HIGH] `recordStockMovement` treats every non-`OUT` type as positive** (`src/lib/automations/stock.ts:65-66`). The manual "Adjustment" option in `AdjustStockForm.tsx` presents IN/OUT/Adjustment as three peer choices with one unsigned quantity field, but only `OUT` actually decreases stock. A downward stocktake correction recorded as "Adjustment" silently *increases* on-hand quantity — the opposite of what the user did. Recommend either dropping "Adjustment" as a UI option (use IN/OUT only) or accepting a signed quantity for it.
- **[MEDIUM] Manual stock-adjustment idempotency key is unused.** `POST /api/inventory/adjust` supports an `idempotencyKey` (`claimIdempotencyKey`, added per the code's own "Phase 13" comment), but `AdjustStockForm.tsx`'s fetch body never sends one — a slow-request retry or a second click after the button re-enables can double-post an adjustment. `docs/INVENTORY_RULES.md` still describes manual adjustments as "intentionally" undeduplicated, which is now stale relative to the API-side protection that was added later and never wired up client-side.

**Confirmed safe:**
- `upsertStockLevelClamped`'s atomic `UPDATE ... SET quantity = GREATEST(0, quantity + $delta)` correctly prevents the classic lost-update race on concurrent stock decrements (two sales confirming at once, or a sale racing a Woo sync).
- `applySalesOrderInventoryEffect` and `applyGoodsReceiptInventoryEffect` are genuinely idempotent via ledger checks (`hasDeductedStock`, an existing-movement lookup keyed by reference) — a retried call is a documented no-op, not a duplicate.
- `checkLowStock()`'s single raw-SQL join and both inventory list/detail pages use batched `include`s — no N+1 anywhere in this area.

**Missing indexes:**
- `ProductVariant.productId` — no `@@index`, despite being the join key for every variant lookup and the `include: { variants }` used on both inventory pages.
- `Product.name` — no index; it's both the search filter and the sort key on the inventory list page (a plain btree wouldn't fully help the `contains` filter, but would help the common empty-search browse-by-name-sorted case).

**Low-severity notes:** the product-detail page's movement history is limited per-variant (top 25) then re-merged and re-sorted in JS to the top 30 overall — a product with several high-activity variants could have a genuinely-recent movement excluded because it was cut off in its own variant's pre-merge limit. Inventory valuation math (`loadInventorySnapshot`) uses plain JS floats with end-rounding, consistent with this codebase's established (non-Decimal) money-math convention elsewhere — not an isolated bug.

## 2. WooCommerce

**Confirmed safe:**
- Duplicate entity creation on sync retry/redelivery is prevented by the `@@unique([externalSource, externalId])` constraint present on Company, Contact, Product, ProductVariant, SalesOrder, and Payment, and every sync path upserts by it.
- Re-syncing an already-imported order never touches its line items (documented, deliberate), so it cannot duplicate them or clobber CRM-side edits.
- The per-site `syncsInFlight` in-process guard prevents two syncs of the *same* site from racing.

**Confirmed/flagged risks:**
- **[LOW-MEDIUM]** `applyWooStockLevel` computes its delta from a point-in-time read of `StockLevel`; a concurrent internal sale landing inside that read-to-write window causes the final quantity to reflect both changes correctly but drift from WooCommerce's own reported snapshot by the sale's amount. Self-correcting on the next sync tick; not a corruption, but worth a decision on whether to tighten it.
- **[LOW-MEDIUM]** The `syncsInFlight` guard is per-process and per-siteId — it does not protect against two *different* WooCommerce sites racing on a shared customer email, and its own code comment already flags the single-process assumption as unenforced if the app is ever run as more than one instance.
- **[LOW]** `upsertWooProduct`'s SKU-collision path has no `P2002` catch of its own, but the surrounding per-item try/catch in the sync loop already contains any such failure safely (logged, not corrupting).

## 3. CRM (Companies/Contacts)

**Confirmed safe:** duplicate-detection (`src/lib/duplicate-detection.ts`) is genuinely wired into both the Company and Contact create routes, not dead code — client forms surface the match and require `confirmDuplicate: true` to proceed. Edit routes don't run the same check, which the code's own comment documents as current (if narrow) scope, not an oversight.

**Confirmed gap:** `Contact.email` has no unique constraint or index at all (see WooCommerce section above for the concrete race this enables during sync).

## 4. Orders (Quotes, SalesOrder, PurchaseOrder)

**Confirmed bug — [HIGH] Quote→SalesOrder double-conversion.** `src/app/api/quotes/[id]/convert/route.ts` has none of the safeguards every sibling financial-effect function in this codebase uses: no quote-status check, no existing-SalesOrder-for-this-quote check, no `pg_advisory_xact_lock` (contrast with `purchase-orders.ts`'s approve/cancel/receive and `sales-orders.ts`'s own status transitions and invoice creation, which all take this lock as their first statement). `SalesOrder.quoteId` also has no `@@unique` constraint, so the database itself doesn't prevent it either. Two concurrent conversion requests (two tabs, or a client retry of a slow request) can create two SalesOrders from one Quote — each independently invoiceable, and each independently able to apply an inventory effect, meaning a customer could be billed twice for one quoted amount. This is the single highest-priority functional bug in this audit, precisely because the *correct* pattern (advisory lock + existing-record check) already exists elsewhere in the same file family and simply wasn't applied here.

**Confirmed safe:** SalesOrder→Invoice creation (`createInvoiceForSalesOrder`) is properly guarded (advisory lock, existing-invoice check, P2002 defense-in-depth) — a good template the quote-convert route should have followed. PurchaseOrder and SalesOrder status transitions (approve/cancel/receive, and SalesOrder's own status machine) are correctly locked and cannot double-apply their effects.

**Confirmed gap — missing indexes:** `Quote.companyId/contactId/opportunityId`, `SalesOrder.companyId/contactId/quoteId`, `PurchaseOrder.supplierId`, and every child line-item table's FK (`SalesOrderItem.salesOrderId`, `QuoteItem.quoteId`, `PurchaseOrderItem.purchaseOrderId`, `GoodsReceipt.purchaseOrderId`) have no `@@index`. `Company.name` has no index either (used by both the duplicate-detection exact-match query and the companies list sort). These compound: a single company-detail-page view issues around seven parallel queries filtering by `companyId`/`supplierId`, none backed by an index.

**Confirmed gap — unbounded list queries:** the Quotes, SalesOrders, PurchaseOrders, and Sales Pipeline pages all do an unpaginated `findMany()` with no `take`/`skip`, unlike Companies/Contacts/Inventory (which already got pagination in a prior phase, `docs/SYSTEM_HARDENING.md` item F4). Not N+1, but the same "won't scale" class of issue — worth extending the same pagination pattern here.

## 5. Invoices

**Confirmed bug — [HIGH] lost-update race on `Invoice.amountPaid`/`status`.** Every payment-recording path (manual entry, the Stripe webhook, the WooCommerce paid-order sync, and the corresponding refund paths) reads `amountPaid`, computes the new absolute value in JavaScript, and writes it back — with no row lock, no atomic increment, and no isolation level stronger than Postgres's default `READ COMMITTED`. Two payments for the same invoice landing close together (the realistic case: a Stripe webhook arriving at the same moment staff records a manual bank-transfer payment) can each read the same stale starting value; whichever write commits last silently overwrites the other's contribution to `amountPaid`. The underlying `Payment` rows are both saved correctly (so `SUM(Payment.amount)` is right), but `Invoice.amountPaid`/`status` — and every AR/receivables view that trusts them directly — can be wrong. Recommended fix direction: an atomic `increment` update (`data: { amountPaid: { increment: amount } } }`) instead of computing the absolute value in application code, with status re-derived in a follow-up read.

**Confirmed bug — [MEDIUM-HIGH] manual-payment idempotency is dead code.** The `idempotencyKey` field and its backing `claimIdempotencyKey` check exist and work correctly, but `InvoiceActions.tsx`'s `RecordPaymentForm` never sends one — so in production this safety net protects nothing; only the button's `disabled={saving}` state guards against a same-tab double-click.

**Confirmed bug — [MEDIUM] edit doesn't re-derive status.** `PUT /api/invoices/[id]` recomputes totals from edited line items but never calls `deriveInvoiceStatus` afterward — an invoice edited down below its already-recorded `amountPaid` keeps its old (now-wrong) status.

**Confirmed bug — [MEDIUM] $0.01 total-vs-parts mismatch.** `computeTotals()` (`src/lib/totals.ts`) rounds `subtotal`, `taxTotal`, and `discountTotal` independently but computes `total` from the unrounded running accumulators before its own final rounding — so the displayed `total` is not always exactly `round2(subtotal) + round2(taxTotal) - round2(discountTotal)`, the same three numbers printed on the same document. A concrete example with realistic decimal-precision inputs is in the agent's full findings; this is small (one cent) but customer/auditor-facing.

**Confirmed safe:** Stripe cents↔dollars conversion is done correctly (avoids float drift before persisting). `amountPaid >= total` status comparisons are safe because every write path rounds to 2 decimals before persisting. No genuine N+1 found in the AR dashboard or profitability functions — both do one query plus in-memory aggregation.

**Confirmed gap — missing indexes:** `Invoice.companyId` (hit by both the customer-360 view and the company-detail page — notably `SalesOrder` already has this index, making its absence on `Invoice` look like an inconsistency rather than a deliberate choice), `Invoice.contactId`/`salesOrderId`, `Payment.invoiceId`, and `InvoiceItem.invoiceId` (both hit every time an invoice is loaded with its items/payments).

**Needs a business decision, not a bug:** tax is computed on the pre-discount line amount everywhere it's calculated (consistently, not a divergence bug) — worth confirming this matches the intended tax treatment for discounted line items.

## 6. Stripe

**Confirmed safe:** the webhook handler is properly idempotent at two layers — a unique `stripeEventId` guard rejects redelivered events before any Payment/Invoice write, and a `stripePaymentIntentId` unique constraint additionally prevents a duplicate Payment even across different event types mapping to the same intent. The WooCommerce-side "payment received" auto-recording relies on the same `(externalSource, externalId)` DB constraint as its real backstop; a narrow pre-check race exists but the database itself blocks any actual duplicate, at worst producing a harmless logged warning. (The `amountPaid` lost-update issue in section 5 also applies to Stripe's payment-recording path specifically — it's one instance of that cross-cutting bug, not a separate one.)

## 7. Automations

**Confirmed safe:** the scheduled-tick lock (`ScheduledTickLock`, a single-row `create()` racing on a primary key) is genuinely atomic — cron, the in-process scheduler, and a manual "run now" cannot both pass it and both commit. Every job function that creates a `Task` goes through the same `ensureTask()` dedupe helper. Payment-reminder sending has two independent layers of protection (a cooldown check plus a day-bucketed idempotency key claimed before sending) — genuinely atomic, not read-then-write.

**Confirmed bugs:**
- **[MEDIUM] N+1 in the overdue-invoice reminder job.** `checkOverdueInvoices` fetches candidate invoices with a bare `findMany` (no `include`), then `sendPaymentReminder` re-fetches the same invoice with its relations inside the loop — a redundant full refetch per invoice, every 15-minute tick.
- **[MEDIUM] Outbound WhatsApp automation actions have no idempotency guard**, unlike every other outbound-message path in this codebase (which all claim an `IdempotencyKey` before sending). A product with two variants crossing their reorder point in the same tick could fire a WhatsApp-sending rule twice for what's arguably one event.
- **[MEDIUM] A failed payment-reminder send is never retried.** The send is only attempted on the tick that *creates* the reminder Task; if that attempt fails, the Task now exists, so `ensureTask`'s dedupe silently prevents every future tick from trying again — a transient SMTP outage at exactly the wrong moment permanently drops that invoice's reminder unless a human notices.

**Confirmed gap — missing indexes:** `AutomationLog` has no indexes at all, despite being queried by both the admin dashboard (sorted by `createdAt`) and webhook failure-lookup logic (filtered by `entityType`/`entityId`).

## 8. AI-assisted features

Re-verified (not re-designed) after the automations/AI agent spot-checked the FACTS builders and the failure-handling paths: every FACTS function (`src/lib/ai/facts.ts`) still computes its numbers purely from the database or existing non-AI aggregation functions, with zero LLM involvement in the figures themselves. Both `runAiSummaryFeature` and `runAiDraftFeature` still wrap generation *and* response-parsing in the same try/catch, degrading to `aiAvailable:false` with the original facts returned unmodified on any failure — never a partially-fabricated result. No regressions found. Index coverage for `AiGenerationLog` (`[feature, createdAt]`, `[entityType, entityId]`) matches its actual query shapes.

## 9. Security

Not re-audited in this pass — see `docs/SECURITY_AUDIT.md`, completed the same day, covering auth/RBAC, IDOR, uploads/webhooks/secrets, injection/XSS/CSRF, and session/error hygiene, with fixes already committed, deployed, and verified in production (`GET /api/health` confirmed `ok` post-deploy).

## 10. Sales-channel abstraction

Confirmed fully isolated and inert, as designed (see `docs/SALES_CHANNEL_ARCHITECTURE.md`): the schema change is purely additive (0 deletions in the migration diff), nothing outside `src/lib/channels/*` and its own test references `ChannelReference` or imports from `channels/`, and the existing WooCommerce sync code's imports and behavior are unchanged. No duplicate/race/N+1/index concerns apply to code that nothing calls yet.

---

## What was NOT done in this pass

Per the audit's own scope: no fixes were applied, no migration beyond the
already-separate sales-channel one was run, no production database was
touched, and nothing was deployed. The findings above are a prioritized
input for a future fix phase, not a change log.

## Verification

`npm run typecheck`, `npm test` (full suite, including three new tests in
`tests/channel-reference.test.ts`), and `npm run build` were run after the
sales-channel schema addition (the only code change in this session) and
are reported in the final summary. No other code changed as part of this
audit.
