# CRM/ERP System Audit — CT Brick Oven Supply

**Date:** 2026-09-22
**Scope:** Full read-only technical audit of the production codebase (`master`, commit `1d97e89`). No code changes, no deploys, no data changes were made as part of this audit.
**Method:** Direct inspection of `prisma/schema.prisma`, all API routes under `src/app/api`, library code under `src/lib`, page code under `src/app/(app)`, Docker/Easypanel configuration, and dependency audit (`npm audit`). `npm run typecheck` was run (clean, zero errors). No automated test suite exists to run (see section L).

---

## A. Current architecture

- **Framework:** Next.js 14.2.35 (App Router), TypeScript, Tailwind CSS.
- **Database:** PostgreSQL via Prisma ORM 5.20/5.22, schema in `prisma/schema.prisma`, 3 migrations applied (`init`, `finance`, `bill_entries`).
- **Auth:** NextAuth (Credentials provider, JWT session strategy), `bcryptjs` password hashing, 4 roles (`ADMIN`, `SALES`, `OPERATIONS`, `ACCOUNTING`) enforced by a static module-access matrix (`src/lib/permissions.ts`).
- **Deployment:** Single Docker image (multi-stage, `node:20-alpine`), Next.js `standalone` output, run as non-root user, deployed via Easypanel on a Hostinger VPS. One Postgres service, one uploads volume. Database migrations are **applied manually** via the Easypanel console (`npx prisma migrate deploy`) after each deploy — this is not automated in the Docker image's `CMD`.
- **Background jobs:** An in-process scheduler (`src/instrumentation.ts` → `instrumentation-node.ts`) starts on server boot inside the same Next.js process and runs automations + email sync every `AUTOMATIONS_INTERVAL_MINUTES` (default 15). A **second**, independent worker entry point (`src/worker/index.ts`, `docker-compose.yml` `worker` service) does the same thing and is not currently deployed in Easypanel, but exists in the repo and compose file as an option.
- **Integrations:** WooCommerce REST API (pull-only), IMAP/SMTP email (per-account credentials, AES-256-GCM encrypted at rest), WhatsApp Cloud API (Meta), WordPress lead-capture webhook, n8n (external, orchestrates WhatsApp → AI agent → CRM webhook).
- **File storage:** Local filesystem under `UPLOADS_DIR` (`/app/uploads`), a single persistent Docker volume. No cloud object storage, no redundancy beyond host-level VPS snapshots/backups.
- **No caching layer, no queue system, no rate limiting, no CDN.** All work is synchronous within a single Next.js request or the in-process scheduler tick.

---

## B. Existing functionality

Companies/contacts/suppliers/employees; sales pipeline (opportunities → quotes → sales orders → invoices → payments); purchasing (purchase orders → goods receipts → supplier invoices → supplier payments); inventory (products, variants, warehouses, stock levels, stock movements); Finance module (expenses, bills-to-review upload/CSV import/approve, aging, monthly cash summary); tasks & calendar; email inbox (IMAP sync, auto-linking to contacts/companies, SMTP send); WhatsApp Business (Cloud API messaging, AI-agent-assisted via n8n, number registration tools); WordPress integration (public content sync, WooCommerce pull sync, lead capture webhook); configurable automation rules; audit log; CSV export on several list pages; dashboard with basic KPIs.

---

## C. Critical bugs

| # | Finding | Where |
|---|---|---|
| **C1** | **Sales-order status changes can double-apply inventory movements.** `POST /api/sales-orders/[id]/status` reads the order's current status, then updates it, then conditionally calls `applySalesOrderInventoryEffect()` based on the value it read *before* the update — with no transaction and no row lock. Two near-simultaneous requests (double-click, retry after timeout, two staff members) that both read `status=DRAFT` will both pass the `previous.status !== 'CONFIRMED'` guard and both deduct stock. There is no unique constraint or idempotency key on `StockMovement` (`referenceType`, `referenceId`, `type`) to prevent this. | `src/app/api/sales-orders/[id]/status/route.ts`, `src/lib/automations/stock.ts` |
| **C2** | **Invoice creation from a sales order has no idempotency guard.** `POST /api/sales-orders/[id]/create-invoice` will happily create a second (third, fourth…) full invoice for the same order on repeat calls (double-click, network retry). Nothing checks `order.invoices.length` first. | `src/app/api/sales-orders/[id]/create-invoice/route.ts` |
| **C3** | **WhatsApp webhook always returns 200, even on internal failure.** `handleInboundWebhook(payload).catch(err => console.error(...))` — any error while processing an inbound message (DB down, bad data, unhandled exception) is swallowed, logged only to container stdout, and the route still returns `{ ok: true }`. Meta will not retry, so the message is silently lost with no trace in the UI, audit log, or automation log. This is the same "invisible failure" pattern already observed once in production this week (messages not reaching n8n went undetected for hours). | `src/app/api/whatsapp/webhook/route.ts` |
| **C4** | **`SupplierInvoice.number` has no uniqueness constraint.** Unlike every other document type (`Quote.number`, `SalesOrder.number`, `Invoice.number`, `PurchaseOrder.number` are all `@unique`), `SupplierInvoice.number` is a plain `String`. Two bills can silently be saved with the same number, and nothing in the API (`POST /api/supplier-invoices`, `POST /api/bills/[id]/approve`) checks for a duplicate. This directly risks duplicate/confused supplier bills, which was explicitly flagged as a concern to check. | `prisma/schema.prisma` (`SupplierInvoice` model) |
| **C5** | **Multiple "active" WhatsApp accounts can exist and which one is used is undefined.** `POST /api/whatsapp/accounts` creates every new account with `active: true` (schema default) and never deactivates the previous one. `getActiveAccount()` (`src/lib/whatsapp/client.ts`) does `findFirst({ where: { active: true } })`, which returns whichever row Postgres/Prisma happens to return first — not guaranteed to be the intended one. This exact situation occurred in production this session (two active WABA-linked accounts existed simultaneously) and was a real contributor to the "messages not arriving" incident. No unique partial index, no UI to deactivate an old account. | `prisma/schema.prisma` (`WhatsAppAccount`), `src/lib/whatsapp/client.ts`, `src/app/api/whatsapp/accounts/route.ts` |

---

## D. High-risk issues

| # | Finding | Where |
|---|---|---|
| **D1** | Document numbering (`generateNumber()`) is `count() + 1`, not a DB sequence or transaction-guarded counter. Under concurrent requests this can compute the same number twice; because most number fields are `@unique`, the loser gets an unhandled Prisma `P2002` error surfaced as a raw 500 (poor UX, and — combined with C4 — a silent duplicate for supplier invoices specifically, which has no unique constraint to even catch it). Numbers are also **not year-continuous with deletions**: deleting any record leaves a permanent gap or, worse, a future collision once the count catches back up. | `src/lib/numbering.ts` |
| **D2** | **Editing a sales order's line items after it has already affected inventory does not reconcile stock.** `PUT /api/sales-orders/[id]` fully replaces `items` (`deleteMany` + `create`) with no check on the order's current status and no corresponding stock reversal/reapplication. An order that was CONFIRMED (stock already deducted) can be edited to change quantities/products, leaving `StockMovement` history permanently out of sync with the order as it now stands. | `src/app/api/sales-orders/[id]/route.ts` |
| **D3** | **Goods receipts can over-receive.** `POST /api/purchase-orders/[id]/receive` validates only that `quantity` is positive — it never checks the received quantity against `purchaseOrderItem.quantity - quantityReceived`. A typo (or a duplicate receipt submission) can push stock in with no ceiling, and the PO status logic (`fullyReceived`/`anyReceived`) will misreport once `quantityReceived` exceeds `quantity`. | `src/app/api/purchase-orders/[id]/receive/route.ts` |
| **D4** | **Two independent schedulers exist that would double-run automations, duplicate reminder emails, and duplicate email sync if both were ever active.** The in-process scheduler (always on inside the `app` container) and the standalone `worker` process (defined in `docker-compose.yml`, not currently deployed on Easypanel but present and documented as an option in the README) both call `runScheduledAutomations()` and `syncEmailAccount()` on their own timers with no distributed lock. This is not firing today (only `app`+`postgres` are deployed), but it is one Easypanel service addition away from silently duplicating every automated invoice-overdue reminder and order-confirmation email. | `src/instrumentation-node.ts`, `src/worker/index.ts`, `docker-compose.yml` |
| **D5** | **No transactions around most multi-write financial operations.** Payment recording (`invoices/[id]/payments`), supplier payment recording, and the bill-approval flow (`bills/[id]/approve`, which creates a `SupplierInvoice` **and** a `SupplierPayment` in two separate calls) are not wrapped in `prisma.$transaction`. A crash or connection drop between the two writes leaves a paid bill recorded as unpaid, or a payment row with no matching invoice update. (The Bills-approve BILL path *does* use `$transaction` for the create-then-update pair in `supplier-invoices/[id]/payments/route.ts` — good — but the *approve* route's own two-step create is not wrapped.) | `src/app/api/bills/[id]/approve/route.ts` |
| **D6** | **Migrations are applied manually and can be forgotten.** Deploys go out via Easypanel automatically on `git push`, but the corresponding `npx prisma migrate deploy` must be run by hand in the Easypanel console afterward (confirmed necessary and performed manually multiple times this session). If skipped even once, the app boots against a schema the code doesn't match — likely hard crashes on any route touching the new table/column, in production, with no safety net. | Deployment process (Dockerfile `CMD` does not run migrations) |
| **D7** | **`npm audit` reports 1 critical + 3 high severity advisories** in the dependency tree (Nodemailer SMTP header/CRLF injection and TLS-validation issues via `next-auth`'s bundled copy; PostCSS XSS/path-traversal, build-time only). The app's own direct `nodemailer` (7.0.13) is newer than `next-auth`'s bundled one and likely not exploitable via the app's own send path, but this needs explicit verification rather than assumption. | `package-lock.json`, confirmed via `npm audit --production` |

---

## E. Medium-risk issues

| # | Finding | Where |
|---|---|---|
| **E1** | CSV export (`toCsv()`) does not neutralize leading `=`, `+`, `-`, `@` characters, so a company/product/note field starting with one of those can execute as a formula when the exported CSV is opened in Excel (classic CSV-injection). Low exploit likelihood (data is mostly self-entered) but real, and it's the kind of thing that bites an accountant opening an export. | `src/lib/csv.ts` |
| **E2** | `automations/engine.ts`'s `ensureTask()` dedupes by exact title text + open status. Once a follow-up task is marked DONE, the very next scheduler tick will re-create it (and, for overdue invoices, re-send the payment-reminder email) if the invoice is still overdue — there's no "reminder already sent for this invoice this week" gate, only "is there currently an open task". | `src/lib/automations/engine.ts` |
| **E3** | `/api/health` returns the raw database error message (`error.message`) to any unauthenticated caller — minor information disclosure about internal infrastructure state. It's correctly excluded from auth middleware (needed for uptime checks), but the error detail shouldn't be public. | `src/app/api/health/route.ts` |
| **E4** | WooCommerce sync (`syncWooCommerce`) has no protection against two syncs running concurrently (e.g., the manual "Sync WooCommerce" button clicked twice, or a future scheduled sync overlapping a manual one) — both would race on the same `upsert` calls. Low practical risk given current low sync frequency and idempotent `externalSource`/`externalId` upserts, but worth a simple in-flight guard. | `src/lib/wordpress/woocommerce.ts` |
| **E5** | Bulk CSV bill import (`POST /api/bills`) uses `createMany`, which is not validated row-by-row for duplicate invoice numbers against existing `BillEntry`/`SupplierInvoice` records — re-importing the same file twice creates duplicate review entries (not duplicate books entries, since they still require manual approval, but it clutters the review queue and risks a distracted approver double-approving). | `src/app/api/bills/route.ts` |
| **E6** | Low-stock automation (`checkLowStock`) loads **every** `StockLevel` row on every 15-minute tick with no pagination/batching. Fine at current catalog size (~58 products); will degrade as inventory grows. | `src/lib/automations/engine.ts` |
| **E7** | `EmailAccount.encryptedPassword`, `WhatsAppAccount.encryptedAccessToken` are encrypted with a single server-wide `IMAP_ENCRYPTION_KEY`. There is no key-rotation mechanism — rotating the key requires re-entering every stored credential, which is a real operational risk if the key is ever suspected compromised (and it has, in effect, already passed through this chat session in plaintext form once). | `src/lib/crypto.ts` |

---

## F. Low-risk improvements

- **F1** No `robots`/rate limiting on public-facing webhook endpoints (`/api/whatsapp/webhook`, `/api/wordpress/leads/webhook`) beyond secret/signature checks — a flood of invalid requests still costs CPU/DB round-trips before being rejected.
- **F2** `generateNumber()` and most numbering schemes reset per document *type*, not per year in the counter itself (the year is only in the string prefix) — if the fiscal year rolls over mid-sequence, numbers like `INV-2026-0143` are followed by `INV-2027-0001`, which is fine, but the **count query has no `WHERE year = ...` filter**, so the count is actually all-time, not per-year — the sequence number will keep climbing across years instead of resetting, contradicting the "year-scoped" doc comment.
- **F3** No `Content-Security-Policy` or other hardening headers configured in `next.config.mjs`.
- **F4** Dashboard and several list pages (`inventory`, `contacts`) have no pagination — they load and render the full table every time; fine today, will slow down as data grows.
- **F5** No `robots.txt`/`sitemap` consideration needed (internal app), but `/api/health` and `/api/whatsapp/webhook` are unauthenticated by design — worth a periodic external log review to catch abuse.
- **F6** ESLint has no committed configuration (`next lint` prompts to create one on first run rather than checking against an existing config) — meaning lint is not actually enforced in this repo today, despite the `lint` script existing.

---

## G. Missing functionality

- No automated tests of any kind (unit, integration, or end-to-end) — see section L.
- No QuickBooks export yet (in progress per user's request; see "Recommended roadmap").
- No way in the UI to deactivate/select which `WhatsAppAccount` is "the" active one (root cause of C5) — it's a database-only concept today.
- No reconciliation report comparing `StockLevel` totals against the sum of `StockMovement` history (would catch drift like D2/D3 after the fact).
- No soft-delete anywhere — `DELETE` routes (`sales-orders/[id]`, `companies/[id]`, etc. — pattern confirmed on sales orders) hard-delete rows. Combined with `onDelete: Cascade` on several child relations (e.g., deleting a `SalesOrder` cascades to `SalesOrderItem`, deleting an `Invoice` cascades to `InvoiceItem` and `Payment`), a mis-click permanently destroys financial history with no undo and no audit trail of *what* was deleted beyond the generic `AuditLog` action.
- No email-bounce or delivery-failure handling for the automated reminder/confirmation emails — `sendPaymentReminder`/`sendOrderConfirmation` failures are caught and logged but never surfaced to a human for follow-up.
- No monitoring/alerting integration (no Sentry, no uptime alerting beyond the unauthenticated `/api/health` endpoint that nothing currently polls).

---

## H. Security concerns

1. **C3** (webhook errors swallowed silently) and **C5** (ambiguous active WhatsApp account) are effectively security/integrity issues as well as bugs — an attacker or a bug elsewhere could cause messages to route to the wrong number or vanish with no trace.
2. **E7** — single non-rotatable encryption key for all third-party credentials at rest.
3. **D7** — dependency vulnerabilities present, need explicit triage rather than the general "npm audit fix --force" (which would jump `next-auth`'s nodemailer indirectly via a major Next.js bump — needs care, not a blind force-fix).
4. **E1** — CSV formula injection on export.
5. Authorization model is coarse (module-level only, not row-level/company-level) — any `SALES` user can see and edit every company's data; there is no data-ownership boundary even though `Company.ownerId` and `Opportunity.ownerId` exist as fields. This is an intentional simplification for a small team today but should be flagged as a boundary the business should be aware of.
6. `middleware.ts` correctly gates all pages/API routes behind auth except the explicitly listed public webhooks and `/api/health` — this is sound, no bypass found.
7. Webhook signature/secret checks (WhatsApp: HMAC-SHA256 or shared secret, WordPress leads: shared secret) use `crypto.timingSafeEqual` correctly — no timing-attack surface found here.
8. No secrets found logged to console in the code paths inspected (WhatsApp client, SMTP, register route).

---

## I. Database concerns

- **C4** (missing `@unique` on `SupplierInvoice.number`) is the standout schema gap.
- No database-level `CHECK` constraints anywhere (e.g., nothing stops `amountPaid > total` on an `Invoice`/`SupplierInvoice`, or a negative `StockLevel.quantity`, at the DB layer — these are only implicitly prevented, inconsistently, by application code).
- `StockLevel.quantity` and `StockMovement.quantity` are plain `Int` — fine for whole-unit inventory (bricks, ovens), but there's no domain constraint preventing a movement from driving a `StockLevel` negative; `recordStockMovement()` does `Math.max(delta, 0)` only on the *create* path, not on the `update`/`increment` path, so an `OUT` movement larger than on-hand stock will happily push `StockLevel.quantity` negative.
- No database-level uniqueness protecting against duplicate customers: `Company` and `Contact` dedupe only via the `(externalSource, externalId)` unique pair (for synced records) — two manually-entered companies with the identical name are not prevented, matching the "duplicate customers" risk called out in the brief. (WooCommerce sync itself does correctly `findFirst`-then-create by case-insensitive name before creating a guest customer/company, which mitigates the sync path specifically — see `resolveOrderCustomer()` — but manual entry via the UI has no such check.)
- No duplicate-product protection beyond `Product.sku @unique` — two products with the same name/description but different SKUs are allowed (not necessarily wrong, but worth knowing).
- Indexes are reasonably placed on frequently-filtered columns (`status`, `dueDate`, foreign keys used in `WHERE`), but there is no composite index for common list-page query patterns (e.g., `Invoice` filtered by `status` *and* ordered by `dueDate` together).
- All migrations reviewed (`init`, `finance`, `bill_entries`) are additive-only (no destructive `ALTER`/`DROP`), consistent with safe production practice so far.

---

## J. Inventory concerns

- **C1, D2, D3** above are the core inventory-integrity risks: double stock deduction on concurrent status changes, no reconciliation after order edits, and unbounded over-receiving on goods receipts.
- `recordStockMovement()` correctly uses a single `prisma.$transaction([...])` for the movement-create + level-upsert pair — this part is sound and race-safe *for a single call*; the risk is entirely at the caller level (duplicate calls), not inside this function.
- WooCommerce-synced products are marked `trackInventory` based on whether Woo reports a stock quantity for them (fixed earlier this session) — correct behavior, but worth noting the CRM's own inventory is **read-only from WooCommerce's perspective**: nothing pushes CRM-side stock movements (e.g., from a CRM-only sale) back to WooCommerce, so the two systems can silently diverge if the CRM is ever used to sell WooCommerce-tracked SKUs directly.

---

## K. WooCommerce concerns

- Sync is **pull-only, manual-trigger or admin-initiated**, not scheduled — orders/products placed on the store won't appear in the CRM until someone clicks "Sync WooCommerce" (confirmed: no automation rule or scheduler tick currently calls `syncWooCommerce`).
- `wooFetch()` paginates correctly (loops with `page=`, stops when a page returns fewer than 100 rows) — good, this was fixed earlier this session and looks correct.
- Guest-checkout customer resolution (`resolveOrderCustomer`) is solid: matches by email case-insensitively, creates a company only when a billing company name is present, matches company by name case-insensitively before creating a duplicate. This is a good pattern that the *manual* company/contact-creation UI does not share (see Database concerns).
- No webhook from WooCommerce → CRM exists (i.e., no push-based near-real-time sync); everything is pull/manual, so "the WooCommerce order total in the CRM Finance dashboard" can lag the real store by however long since the last manual sync.
- No handling for WooCommerce order **refunds** — a refunded order in Woo has no corresponding status/amount adjustment path in the sync (`mapWooStatus` only maps to `CANCELLED` for `cancelled|refunded|failed`, which conflates "never happened" with "happened, then money was returned" — different financial treatment, especially relevant now that Finance/Bills exist).

---

## L. Financial concerns

- **C2** (duplicate invoice creation from an order) and **C4** (non-unique supplier invoice numbers) are the most serious financial-integrity findings.
- Finance dashboard (`src/lib/finance.ts`) is explicitly documented (in its own UI copy) as counting only invoice `Payment` rows as "money received" — WooCommerce-paid orders are **not** counted as received even though the customer already paid online. This was a known, disclosed gap from earlier in the session (decision deferred to "tomorrow"), but it means today's Finance totals **understate actual cash received** for any period with online WooCommerce sales. This is not a bug so much as an unresolved design decision that materially affects the accuracy of the numbers shown.
- `computeTotals()` (quotes/orders/invoices) and the ad-hoc subtotal math in `purchase-orders/route.ts` round only at the final subtotal/tax/discount/total level (`round2()`), not per line — for typical low-line-count orders this is immaterial, but it's worth knowing it's not the "round every line, then sum" approach some accounting systems expect, since the two can differ by a cent on edge cases.
- Bill approval (`bills/[id]/approve`) auto-creates a new `Company` (type `SUPPLIER`) for any vendor name that doesn't already match one case-insensitively — same class of behavior as the WooCommerce guest-customer path, but here it's user-typed free text with no fuzzy matching, so "Acme Supply" and "Acme Supply Co." will create two supplier records for the same real vendor.
- No sales-tax jurisdiction logic anywhere — `taxRate` is a flat manually-entered percentage per line item, with no state/location awareness. Fine if the business only ever charges one rate, but worth flagging before any multi-state selling.
- The QuickBooks export (explicitly promised for "tomorrow") does not exist yet in the codebase — confirming there is currently **no path out of the CRM's numbers into the official books** other than manual re-entry.

---

## M. Recommended development roadmap

### Phase 0 — Stop-the-bleeding (do first, low effort, high value)
1. Add `@unique` to `SupplierInvoice.number` (with a migration + a duplicate-check pass on existing data first). **[CRITICAL]**
2. Wrap the sales-order status-change + inventory-effect logic in a `prisma.$transaction` with a `WHERE status = <previous>` guard on the update (optimistic concurrency), so a second concurrent request sees 0 rows affected and can no-op instead of double-applying. **[CRITICAL]**
3. Add an idempotency check to `create-invoice` (refuse, or return the existing invoice, if `order.invoices.length > 0` already covers the order — or explicitly support multiple invoices per order but require confirmation). **[CRITICAL]**
4. Stop swallowing WhatsApp webhook errors silently: log to `AutomationLog`/`AuditLog` (not just stdout) and consider returning non-200 on genuine internal errors so Meta retries, while still always returning 200 for "not authorized"/"bad payload" (those shouldn't be retried). **[CRITICAL]**
5. Enforce a single active `WhatsAppAccount`: on activating one, deactivate all others in the same transaction; add a UI control for it. **[CRITICAL]**

### Phase 1 — Data integrity (next)
6. Add a `WHERE quantityReceived + :qty <= quantity` guard (or a clamping warning) to the goods-receipt route. **[HIGH]**
7. Decide and implement the sales-order-edit-after-confirmation policy: either lock items once `CONFIRMED`+ (simplest), or auto-reverse/reapply stock movements on edit. **[HIGH]**
8. Replace `count()`-based numbering with either a Postgres sequence per document type, or a transaction-guarded "next number" table with `SELECT ... FOR UPDATE`. **[HIGH]**
9. Wrap `bills/[id]/approve`'s two-write BILL path in `$transaction`. **[HIGH]**
10. Decide: keep, fix (single-instance lock), or remove the redundant `worker` process entirely to eliminate the double-scheduler risk before it's ever accidentally deployed. **[HIGH]**
11. Triage the 4 `npm audit` findings explicitly (confirm the app's own nodemailer usage path is unaffected; assess whether upgrading `next-auth`/Next.js is worth the breaking-change risk right now, or whether to pin and monitor). **[HIGH]**

### Phase 2 — Correctness & completeness (soon)
12. Fix the low-stock `Math.max` gap so `StockLevel.quantity` cannot go negative via the increment path either.
13. Add manual-entry duplicate-company/contact detection (name+email/phone fuzzy match with a "possible duplicate" warning), matching what the WooCommerce sync path already does.
14. Decide and implement the WooCommerce "money received" treatment in Finance (count paid Woo orders as received, or require them to be matched to a CRM Payment — this was already flagged as open).
15. Add WooCommerce refund handling (separate status/negative-amount handling from plain cancellation).
16. CSV export: neutralize leading `=`, `+`, `-`, `@` in exported cells.

### Phase 3 — Hardening & scale (later)
17. Add pagination to Inventory/Contacts/Companies list pages.
18. Add a stock-reconciliation report (StockLevel vs. sum of StockMovement).
19. Add basic automated tests, starting with the highest-risk pure functions (`computeTotals`, `generateNumber`, `recordStockMovement`, the WhatsApp webhook auth check) before touching route handlers.
20. Add monitoring (uptime + error tracking) so silent failures like C3 surface proactively instead of being found by a customer.
21. QuickBooks export (already scheped for next session — not re-scored here since it's new functionality, not a fix).

### Future
22. Row/company-level authorization if the team grows beyond a fully-trusted small staff.
23. Encryption-key rotation support.
24. Move uploads to redundant object storage (S3-compatible) instead of a single VPS volume.

---

## N. Dependencies between improvements

- **#2 (transaction-guarded status change)** should land **before** #7 (edit-after-confirm policy) — the edit policy's stock-reversal logic will itself need the same transaction pattern, so building it on top of an already-race-prone base doubles the work.
- **#8 (proper numbering)** should land **before** #1's migration is finalized for `SupplierInvoice` — otherwise the new unique constraint can immediately start throwing under the same race that #8 fixes, just moved to a different table.
- **#5 (single active WhatsApp account)** has no dependencies and can ship independently and immediately.
- **#4 (webhook error visibility)** should land **before** #10 (worker/scheduler decision) — once errors are visible, it'll be much easier to detect *if* a duplicate-scheduler situation is ever accidentally happening in the logs/AutomationLog.
- **#11 (dependency triage)** is independent but should be scheduled before any unrelated major-version dependency bump (e.g., don't let a future "let's update Next.js" task blindly run `npm audit fix --force`, which jumps Next to a major version as a side effect).
- **#13 (duplicate company/contact detection)** benefits from **#3 being shipped first only in spirit** (both are "prevent duplicates" work) but has no hard technical dependency.
- **Phase 2 item #14 (WooCommerce money-received policy)** should be decided **before** any QuickBooks export work (#21/Phase 2-external), since the export will otherwise encode today's understated "received" numbers into the official books.

---

## Recommended implementation order (flat list, top = do first)

1. Add `@unique` to `SupplierInvoice.number` + de-dupe migration (C4)
2. Single active `WhatsAppAccount` enforcement (C5)
3. Transaction-guarded sales-order status change (C1)
4. Idempotent `create-invoice` (C2)
5. Surface WhatsApp webhook errors instead of swallowing them (C3)
6. Proper document numbering (sequence or locked counter) (D1)
7. Goods-receipt over-receive guard (D3)
8. Sales-order edit-after-confirmation policy + stock reconciliation (D2)
9. Transaction-wrap bill approval's BILL path (D5)
10. Resolve the dual-scheduler risk (remove or lock the `worker` service) (D4)
11. Triage `npm audit` findings (D7)
12. Negative-stock guard on the increment path (I)
13. CSV export formula-injection fix (E1)
14. Manual duplicate-company/contact warning (G)
15. WooCommerce "money received" policy decision, then reflect it in Finance (L)
16. WooCommerce refund handling (K)
17. Pagination on large list pages (F4)
18. Basic automated test coverage for the functions above, added as each is touched (G)
19. Monitoring/alerting (G)
20. QuickBooks export (new functionality — scheduled next session)

---

## Build/typecheck verification performed for this audit

- `npm run typecheck` (`tsc --noEmit`) — **passed, zero errors.**
- `npm run lint` — **could not run**: no ESLint configuration file exists in the repo, and `next lint` requires interactive setup on first run (non-interactive audit session, so this was not completed — see F6).
- `npm audit --production` — **4 vulnerabilities (1 critical, 3 high)**, detailed in D7.
- Full `next build` was not re-run for this audit: it is exercised on every deploy today (9 successful production deploys this session prove the build pipeline works), so re-running it here would not have added new information within a read-only audit.
- No automated test suite exists to run (`package.json` has no `test` script, no `*.test.*`/`*.spec.*` files found anywhere in the repo).

**No files outside `docs/SYSTEM_AUDIT.md` were created or modified. No deploy was triggered. No environment variables, credentials, or database rows were changed.**
