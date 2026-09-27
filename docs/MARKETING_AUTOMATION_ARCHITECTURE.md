# Marketing Automation Engine — Architecture (Phase 1: Audit & Design)

Status: **design only**. Phase 1 changes no code, no Prisma schema, and no dependencies.
Everything under "Proposed" is for later phases and needs sign-off before implementation.

---

## 1. System inventory (as of `8a03972`)

### 1.1 Platform

| Layer | Current state | Source |
|---|---|---|
| Framework | Next.js 14.2 App Router, Node runtime for all API routes | `package.json`, `src/app/` |
| DB / ORM | PostgreSQL + Prisma 5.22 (pinned). 16 additive migrations; hand-written CHECK constraints in some | `prisma/schema.prisma`, `prisma/migrations/` |
| Auth | NextAuth v4 Credentials provider, JWT sessions (12h), `role` on token | `src/lib/auth.ts` |
| Edge gate | `next-auth/middleware` protects everything except an explicit allowlist of public webhook paths | `src/middleware.ts` |
| Route authz | `requireApiSession()` / `requireApiModule(module)`; role×module matrix (ADMIN, SALES, OPERATIONS, ACCOUNTING) | `src/lib/api-auth.ts`, `src/lib/permissions.ts` |
| Machine auth | `requireCronSecret()` (`x-cron-secret`), per-integration shared secrets, all compared with `safeEqual` (timing-safe) | `src/lib/api-auth.ts`, `src/lib/crypto.ts` |
| Secrets at rest | AES-256-GCM `encryptSecret`/`decryptSecret` (key: `IMAP_ENCRYPTION_KEY`) | `src/lib/crypto.ts` |
| Scheduling | In-process scheduler + optional worker + `POST /api/automations/run`, all serialized by a single-row lease (`ScheduledTickLock`) | `src/instrumentation-node.ts`, `src/worker/index.ts`, `src/lib/automations/tick-lock.ts` |
| Job bookkeeping | `AutomationJobRun` (job-level status/retries), `AutomationLog` (per-item), `IdempotencyKey` (claim-before-act) | `src/lib/automations/*` |
| Audit | `AuditLog` via `logAudit()`; AI calls in `AiGenerationLog` | `src/lib/audit.ts`, `src/lib/ai/audit.ts` |
| Tests | Vitest against embedded Postgres (`tests/test-db.ts`), 40+ suites incl. webhook/idempotency/authz | `tests/` |

**Established conventions a marketing module must follow:** raw `fetch` to provider REST APIs (no vendor SDKs except Stripe); zod validation on every route body; fail-closed on missing config; never fabricate success; best-effort bookkeeping writes must not break the primary action; unknown cost is `null`, never `0`.

### 1.2 External integrations

| Integration | Direction | Auth | Where |
|---|---|---|---|
| **WooCommerce** | Pull (orders, products, customers) | Consumer key/secret | `src/lib/wordpress/woocommerce.ts`, `/api/wordpress/sites/[id]/sync-woocommerce` |
| **WordPress** | Pull content → `KnowledgeBaseArticle`; inbound lead webhook → `WordPressLead` (stores `consentGiven`) | App password; `x-webhook-secret` | `src/lib/wordpress/client.ts`, `/api/wordpress/leads/webhook` |
| **Meta — WhatsApp Cloud API** | Outbound send (Graph `v20.0`); inbound webhook | Encrypted per-account token; `X-Hub-Signature-256` (`WHATSAPP_APP_SECRET`) **or** `x-forward-secret` from n8n | `src/lib/whatsapp/client.ts`, `/api/whatsapp/webhook` |
| **n8n** (external) | Currently relays WhatsApp → AI agent → CRM webhook. The only existing n8n contract is **inbound** (`x-forward-secret`). No outbound CRM→n8n calls exist today | `WHATSAPP_FORWARD_SECRET` | `/api/whatsapp/webhook` |
| **Anthropic** | Outbound, synchronous, one call site (`generateCompletion`), raw fetch, model via `ANTHROPIC_MODEL` (default `claude-sonnet-5`), every call logged | `ANTHROPIC_API_KEY` | `src/lib/ai/client.ts`, `src/lib/ai/service.ts`, `/api/ai/*` |
| **Stripe** | Inbound webhook, event-id dedupe (`StripeWebhookEvent.stripeEventId @unique`) | `STRIPE_WEBHOOK_SECRET` | `src/lib/stripe/webhook.ts` |
| **IMAP/SMTP** | Email sync/send | Encrypted per-account creds | `src/lib/email/*` |
| **Sales channels** | `ChannelReference` mapping only; Amazon/Walmart/**TikTok Shop are stubs** (throw `notImplemented`) | — | `src/lib/channels/*` |

**Not present:** Meta Pages/Instagram Graph (social posting), TikTok content-posting API, Canva, CapCut, any video pipeline, any outbound webhook to n8n. The WhatsApp Graph token is scoped to the WABA and must **not** be reused for Page/IG posting.

### 1.3 Audit findings relevant to this project

1. **Middleware allowlist is regex-by-path.** Every new public webhook requires editing `src/middleware.ts`; a typo either exposes a route or breaks the callback. Marketing should need exactly **one** new public path.
2. **One scheduler lease for everything.** Putting marketing dispatch into `runAutomationsTickExclusive()` would let a slow n8n call delay invoice/stock automations. Marketing needs its **own lease row** (same table, different `id` — no schema change).
3. **`getProductCostMap()` scans all products + all goods-receipt items.** Fine for the current catalog; for per-promotion checks it should be callable per product (backward-compatible optional filter, Phase 2).
4. **Stock is deducted only at `CONFIRMED`/`SHIPPED`/`DELIVERED`** (`STOCK_HOLDING_STATUSES`). `StockLevel.quantity` therefore does **not** reflect DRAFT orders — relevant to "available to promote".
5. **`AiFeature` is a core enum.** Adding marketing values alters a core table's type; marketing AI calls should log to their own table.
6. **Consent is recorded but never enforced downstream.** `WordPressLead.consentGiven` exists; no audience-building code reads it. Any marketing audience (email/WhatsApp) must.

---

## 2. Non-destructive integration strategy (CRM/ERP isolation)

**Principle: marketing may *read* core data through a narrow facade and may *write* only its own tables. Core never imports marketing.**

| Rule | Enforcement |
|---|---|
| All marketing code lives in `src/marketing/**`; thin Next.js entry points only in `src/app/api/marketing/**` and `src/app/(app)/marketing/**` | Code review + directory convention |
| Core (`src/lib/**`, existing `src/app/**`) never imports `@/marketing/*` | ESLint `no-restricted-imports` in `.eslintrc` (config only, no new package) |
| Marketing reads core models **only** via `src/marketing/integrations/erp-readonly.ts` (typed, `select`-limited queries) | ESLint rule: `@/lib/prisma` import allowed in `src/marketing/**` only from that file + `src/marketing/**/repo.ts` files touching `Mkt*` models |
| No marketing writes to core tables (Product, StockLevel, SalesOrder, Invoice, Payment, Company, Contact, …) | Vitest guard test that greps `src/marketing/**` for `prisma.<coreModel>.(create|update|upsert|delete)` and fails |
| New tables are additive, prefixed `Mkt*`, with **soft references** to core (plain `productId String`, no FK) | Prevents cascade/Restrict side-effects on core deletes; migration review |
| No edits to existing enums (`AiFeature`, `AutomationTrigger`, `RelatedEntityType`) | Marketing defines its own enums |
| Separate secrets per boundary (never reuse `CRON_SECRET`, `WHATSAPP_FORWARD_SECRET`) | Env naming: `MARKETING_*` |
| Separate scheduler lease: `ScheduledTickLock` row `id = 'marketing-dispatch'` | Row insert, no schema change; marketing failures cannot block ERP ticks |
| Kill switch: `MARKETING_ENABLED=false` → all marketing routes 503, dispatcher no-ops | Checked at every entry point |
| Optional hardening: dedicated Postgres role with `SELECT` on core tables, full rights on `Mkt*` | Deferred; requires a second `DATABASE_URL` |

**Required minimal touches to existing files (later phases, each gated):**
- `src/lib/permissions.ts` — add `'marketing'` module (ADMIN + SALES by default). Additive.
- `src/middleware.ts` — add `api/marketing/webhooks/n8n` to the public allowlist.
- `prisma/schema.prisma` — append `Mkt*` models in a new section; one additive migration.
- `src/lib/profitability.ts` — optional `productIds` filter on `getProductCostMap()` (default behavior unchanged).

---

## 3. Read-only promotion safeguards (inventory + margin)

A promotion cannot be approved or dispatched unless **every** product it references passes the gate. The gate is pure reads and **fails closed**.

### 3.1 Inputs (all read-only)

| Signal | Source |
|---|---|
| On-hand | `SUM(StockLevel.quantity)` per variant across active warehouses |
| Committed-not-deducted | `SUM(SalesOrderItem.quantity)` on `DRAFT` orders (policy flag; see 1.3 #4) |
| Tracking | `Product.trackInventory`, `Product.active`, `ProductVariant.active` |
| Price | `Product.price + ProductVariant.priceDelta` |
| Unit cost | `getProductCostMap()` — purchase-history weighted avg → standard cost → **unknown** |

### 3.2 Rules (defaults, configurable via `MktSafeguardPolicy`)

| Check | Pass condition | On failure |
|---|---|---|
| Active | product and variant active | BLOCK |
| Stock | `available = onHand − committed ≥ max(minPromoStock, reorderPoint + bufferUnits)` | BLOCK |
| Cost known | `unitCost !== null` | **BLOCK** (never treat unknown as 0) |
| Margin | `(promoPrice − unitCost) / promoPrice ≥ minMarginPct` where `promoPrice = price × (1 − discountPct)` | BLOCK |
| Floor price | `promoPrice ≥ unitCost × (1 + minMarkupPct)` | BLOCK |
| Low-confidence cost | `source = 'standard_cost'` | WARN (reviewer must acknowledge) |
| Untracked inventory | `trackInventory = false` | WARN |

### 3.3 When it runs
1. **Draft/preview** — shown to the author (advisory).
2. **Approval** — hard gate; result snapshot stored on `MktSafeguardCheck` (inputs + verdict + policy version).
3. **Dispatch to n8n** — re-evaluated (stock/cost can change between approval and posting). If it now fails → campaign moves to `BLOCKED`, nothing is sent.

Output shape: `{ verdict: 'PASS'|'WARN'|'BLOCK', checks: [{ productId, variantId, rule, value, threshold, ok }], evaluatedAt, policyVersion }`. The AI layer may *explain* a verdict; it may never override it.

---

## 4. Webhook architecture (CRM ⇄ n8n)

The CRM decides **what** and **whether**; n8n does the **heavy work** (Anthropic long-form/multimodal, Canva renders, CapCut templates, Meta/TikTok posting). Platform credentials for Meta Pages/IG, TikTok, Canva, CapCut live **only in n8n**.

```
 CRM (Next.js)                                         n8n
 ─────────────                                         ───
 approve → safeguard gate → MktJob(PENDING)
 marketing-dispatch tick (own lease)
   └─ POST  N8N_MARKETING_WEBHOOK_URL/<workflow> ───────▶  Webhook node (respond 202 immediately)
        signed, idempotent (jobId)                          ├─ Anthropic / Canva / CapCut / render
                                                            ├─ Meta Graph / TikTok post
   POST /api/marketing/webhooks/n8n  ◀──────────────────────┘  callback(s): progress | result | error
     verify HMAC + timestamp → dedupe → update Mkt* only
```

### 4.1 Outbound (CRM → n8n) — outbox pattern
- Row written to `MktJob` in the same transaction as the state change (no network I/O inside the transaction).
- The `marketing-dispatch` tick claims `PENDING` jobs, POSTs, marks `DISPATCHED` on 2xx; retries with backoff up to `maxAttempts`, then `FAILED` (mirrors `AutomationJobRun`).
- Headers:
  - `X-Mkt-Job-Id: <jobId>` — n8n dedupes on this
  - `X-Mkt-Timestamp: <unix seconds>`
  - `X-Mkt-Signature: sha256=HMAC(MARKETING_N8N_OUTBOUND_SECRET, timestamp + "." + rawBody)`
- Body: `{ jobId, type: 'content.generate'|'video.render'|'social.publish'|…, campaignId, payload, callbackUrl }`. Payload carries **only** what the job needs (no customer PII for social jobs).
- Timeout ≤10s; n8n must ack fast and do work asynchronously.

### 4.2 Inbound (n8n → CRM) — single endpoint `POST /api/marketing/webhooks/n8n`
- Public in middleware; authenticated by HMAC with **separate** `MARKETING_N8N_INBOUND_SECRET`, `safeEqual` compare, reject if `|now − timestamp| > 300s`.
- Dedupe: `claimIdempotencyKey('mkt-cb:' + eventId, 'marketing')` (existing table, new scope).
- zod-validated body: `{ eventId, jobId, status: 'progress'|'succeeded'|'failed', outputs?: { assetUrls?, postIds?, text? }, error? }`.
- Writes **only** `MktJob`, `MktAsset`, `MktSocialPost`, `MktEvent`. Unknown `jobId` → 404 (logged), never creates core records.
- Returns 500 on genuine processing failure so n8n retries (same lesson as SYSTEM_AUDIT C3).
- AI-generated content arriving by callback lands as `DRAFT` requiring human approval before any publish job.

### 4.3 Analytics ingestion
n8n pulls platform metrics on its own schedule and posts `status: 'metrics'` events to the same endpoint → `MktMetricSnapshot`. The CRM never calls Meta/TikTok directly.

---

## 5. Proposed directory layout

```
src/marketing/
├── campaigns/      Campaign aggregate + state machine (DRAFT → PENDING_REVIEW → APPROVED → SCHEDULED → DISPATCHED → PUBLISHED | BLOCKED | FAILED)
├── content/        Copy/caption variants, per-channel formatting & length limits, brand-voice rules
├── templates/      Reusable prompt/post/video templates (references to Canva/CapCut template IDs, never binaries)
├── assets/         Asset registry (URLs + metadata from n8n/Canva); upload validation reusing src/lib/uploads.ts rules
├── videos/         Video job specs (CapCut template + slots), render status tracking — rendering itself is in n8n
├── social/         Channel descriptors (META_FB, META_IG, TIKTOK), post specs, per-channel constraints
├── scheduling/     marketing-dispatch tick, own ScheduledTickLock row, outbox claim/retry
├── analytics/      Metric snapshot ingest + read models; attribution joins to core are read-only
├── ai/             Short in-app copy assist via existing generateCompletion(); own MktAiLog; grounding prompts
├── approvals/      Human-in-the-loop review, reviewer ack of WARN checks, approval audit via logAudit()
└── integrations/
    ├── erp-readonly.ts   The ONLY facade onto core data (products, stock, cost, consented contacts)
    ├── safeguards.ts     Section 3 gate (pure reads)
    ├── n8n-outbound.ts   Signing + POST
    └── n8n-inbound.ts    Verification + dedupe + dispatch to handlers
```

Next.js entry points (thin, call into `src/marketing`): `src/app/api/marketing/**`, `src/app/(app)/marketing/**`. Tests: `tests/marketing-*.test.ts`. The existing `@/*` path alias already resolves `@/marketing/*`.

### Proposed tables (Phase 2, additive, soft references)
`MktCampaign`, `MktCampaignProduct` (productId/variantId as plain strings), `MktContent`, `MktTemplate`, `MktAsset`, `MktJob`, `MktSocialPost`, `MktSafeguardPolicy`, `MktSafeguardCheck`, `MktApproval`, `MktEvent`, `MktMetricSnapshot`, `MktAiLog`.

### Proposed env vars
`MARKETING_ENABLED`, `N8N_MARKETING_WEBHOOK_URL`, `MARKETING_N8N_OUTBOUND_SECRET`, `MARKETING_N8N_INBOUND_SECRET`, `MARKETING_DISPATCH_INTERVAL_MINUTES`.

---

## 6. Phasing & open decisions

| Phase | Scope |
|---|---|
| 2 | `Mkt*` schema + migration, `marketing` permission, isolation lint + guard test, `erp-readonly` + safeguards (with tests) |
| 3 | Campaigns/content/approvals UI + API; in-app AI copy assist |
| 4 | Outbound/inbound n8n webhooks, dispatch tick, middleware allowlist entry |
| 5 | n8n workflows: content generation, Canva/CapCut video, Meta/TikTok publishing |
| 6 | Analytics ingest + dashboards |

**Decisions (confirmed 2026-09-27):**
1. DRAFT sales orders **count** against promotable stock (`available = onHand − DRAFT committed`).
2. Defaults: `minMarginPct = 25%`, `minPromoStock = 2` units, `bufferUnits = 1` unit.
3. `standard_cost` (manually entered) is allowed with a **WARN** when purchase history is absent; unknown cost still BLOCKs.
4. Approval is **ADMIN only**.
5. Marketing **will** message contacts (WhatsApp/Email): audiences must enforce explicit opt-in consent per channel.
