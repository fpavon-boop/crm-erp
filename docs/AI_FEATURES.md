# AI-Assisted Features

**Date:** 2026-09-26 (Phase 14)
**Status:** Implemented and tested. This document is the explicit behavior —
code should match this, not the other way around.

## What this is

A set of assistive, human-in-the-loop AI features layered on top of data
this app already has: customer/sales/product/invoice summaries, a
follow-up-suggestion feature, an inventory-warning explainer, and an email
draft assistant. None of it is a new automation — nothing here runs on a
schedule, and nothing here writes, sends, or changes business data. Every
feature reads the database, optionally asks an LLM to synthesize what it
read into plain English, and returns that to a human to review.

## Safety boundaries (non-negotiable)

- **Human-in-the-loop, always.** No AI route in this app can send a
  message, issue a refund, modify inventory, or create/delete/update any
  business record. The Email Draft Assistant returns text into the same
  editable `<textarea>` a template would (`SendCommunicationForm.tsx`) —
  a human still has to click Send. The other six features return a
  read-only JSON summary; nothing about calling them changes any data
  except one row in a dedicated audit table (see "Audit logging" below).
- **Grounding.** Every fact the AI is allowed to talk about is computed
  in code, from the database, before the AI is ever called — see
  "Architecture" below. The AI is never given free rein to query
  anything; it only ever sees a fixed list of already-verified strings.
- **Anti-hallucination.** The shared system prompt
  (`src/lib/ai/prompts.ts`, `AI_SYSTEM_PROMPT`) explicitly forbids
  inventing, assuming, or inferring anything beyond the FACTS it's given,
  and specifically calls out that a fact like "No prior contact found"
  must not be contradicted. This is enforced two ways: instructionally
  (the prompt), and structurally (the FACTS returned to the UI are always
  the code-computed ones, never the AI's own text — even if the AI
  hallucinated in its summary, the facts panel next to it is still
  accurate, because the AI never wrote it).
- **No unnecessary PII/secrets in prompts.** Fact strings include what a
  feature actually needs (a contact's name/email when drafting them an
  email, a company's financial totals when summarizing their account) —
  never raw database rows, never credentials, tokens, or other accounts'
  data. `AI_SYSTEM_PROMPT` also explicitly forbids the model from echoing
  back anything credential-shaped.

## Architecture

```
src/lib/ai/
  client.ts     — the only place that calls out to Anthropic's API (raw
                  fetch, no SDK dependency — same convention as
                  src/lib/whatsapp/client.ts's Graph API calls).
  types.ts      — AiFeatureResult (facts/summary/recommendations) and
                  AiDraftResult (facts/subject/body).
  prompts.ts    — the shared system prompt, per-feature user-prompt
                  builders, and response parsers (tolerant of a malformed
                  or non-JSON reply — never throws, always degrades to
                  something safe).
  facts.ts      — one deterministic, code-only "FACTS builder" function
                  per feature. Never calls the AI. Reuses the app's
                  existing authoritative aggregation functions
                  (getCustomer360, getDashboardData,
                  getAccountsReceivableDashboard, getProductProfitability)
                  rather than re-deriving totals independently.
  service.ts    — runAiSummaryFeature() / runAiDraftFeature(): the
                  centralized service layer. Builds the prompt, calls the
                  client (or an injected stub in tests), parses the
                  response, writes the audit log row, and — on any
                  failure — degrades to an explicit "AI unavailable"
                  result instead of throwing or fabricating content.
  audit.ts      — logAiGeneration(): writes one AiGenerationLog row per
                  call, success or failure.
  auth.ts       — requireAiModule(): the double access-control gate (see
                  "Access control" below).
```

Every route in `src/app/api/ai/*/route.ts` follows the same shape:
auth → validate body → build facts (a `facts.ts` function; 404 if the
entity doesn't exist) → `runAiSummaryFeature()` / `runAiDraftFeature()` →
return the result as JSON. No route ever calls `prisma.<model>.create /
update / delete` on business data — the only write in the entire `src/
app/api/ai` tree is the audit log insert inside `runAiSummaryFeature` /
`runAiDraftFeature` itself.

### Why facts and AI output are separate fields

`AiFeatureResult` (`src/lib/ai/types.ts`) is:

```ts
{ facts: string[]; summary: string; recommendations: string[]; aiAvailable: boolean; model: string | null; generatedAt: string }
```

`facts` is always the exact array `src/lib/ai/facts.ts` produced — the AI
never touches it. `summary`/`recommendations` come from the model's
parsed JSON response. If the AI call fails (no API key, a network error,
an API error) or its response can't be parsed as the requested JSON
shape, `aiAvailable` is `false` and `summary` explicitly says the AI
summary is unavailable — `facts` is still returned, so the UI (and the
person using it) always has the real, verified data even when the AI
layer itself is down. Nothing here ever fabricates a plausible-looking
summary to paper over a failure.

### Prompt grounding strategy

Every request to the model looks like:

```
FACTS:
- <fact 1>
- <fact 2>
...

TASK: <feature label>
<feature-specific instructions>

Respond with exactly this JSON shape: {...}
```

The system prompt (sent on every call, not repeated per-feature) is the
actual safety contract — see `AI_SYSTEM_PROMPT` in `src/lib/ai/prompts.ts`
for the exact text. It is deliberately the same for all seven features;
only the FACTS and the one-line TASK instructions vary per call.

## Features

| Feature | Route | Facts source | Domain module required (in addition to `ai`) |
|---|---|---|---|
| Customer Summary | `POST /api/ai/customer-summary` `{companyId}` | `getCustomer360()` | `companies` |
| Sales Summary | `POST /api/ai/sales-summary` `{}` | `getDashboardData()` | `dashboard` |
| Customer Follow-Up Suggestions | `POST /api/ai/follow-up-suggestions` `{companyId}` | inactive quotes, AR aging, pending tasks | `companies` |
| Product Sales Analysis | `POST /api/ai/product-analysis` `{productId}` | `getProductProfitability()` (30d vs. prior 30d) + stock levels | `inventory` |
| Inventory Warning Explanation | `POST /api/ai/inventory-warning` `{productVariantId, warehouseId}` | one stock level + open confirmed orders needing it | `inventory` |
| Invoice / Account Summary | `POST /api/ai/invoice-summary` `{companyId}` | `getAccountsReceivableDashboard()` + recent payments | `invoicing` |
| Email Draft Assistant | `POST /api/ai/email-draft` `{companyId, contactId?, intent, relatedType?, relatedId?}` | recent CommunicationLog + (optionally) one related quote/order/invoice | `inbox` |

"Inactive quote" (Follow-Up Suggestions) means a `SENT` quote whose
`validUntil` has passed, or — if it has none — one older than
`STALE_QUOTE_DAYS` (14 days, `src/lib/ai/facts.ts`).

## Access control

Every AI route calls `requireAiModule(domainModule)`
(`src/lib/ai/auth.ts`), which checks **two** things: the role has the
general `ai` module (added to `src/lib/permissions.ts`'s `MODULES`, and
to every role's array — ADMIN, SALES, OPERATIONS, ACCOUNTING all have
it), **and** the role has the specific domain module the feature's data
comes from (per the table above). This second check matters because the
four roles don't all have the same domain modules — ACCOUNTING, for
example, has `invoicing` but not `inventory` — and without this check the
AI layer would be a back door around those existing restrictions. See
`tests/ai-routes.test.ts` for the regression test proving this (an
ACCOUNTING session is blocked from `/api/ai/product-analysis` with a 403,
but allowed through `/api/ai/invoice-summary`).

## Audit logging

Every AI call — success or failure — writes one `AiGenerationLog` row
(`prisma/schema.prisma`, migration
`20260926020000_ai_generation_log`): `feature` (the `AiFeature` enum),
`entityType`/`entityId` (what the call was about), `requestedById` (the
signed-in user), `companyId` (when applicable), `model`, `status`
(`SUCCESS`/`FAILED`), `errorMessage`, and `createdAt`. This is a separate
table from the generic `AuditLog` (used for CRUD/business actions)
because an AI call never mutates business data — its own shape (model
name, success/failure, no `changes` diff) is different enough to warrant
its own table rather than overloading `AuditLog.changes`, the same
reasoning that led to `AutomationJobRun` existing alongside `AutomationLog`
(Phase 13, `docs/AUTOMATION_SYSTEM.md`).

The audit write itself is best-effort: if it fails, the error is logged
to the console but does not take down an otherwise-successful AI
response (`src/lib/ai/audit.ts`) — the same "secondary bookkeeping can
degrade gracefully without losing the primary result" precedent as
`recordIdempotentResult()` (Phase 13, `src/lib/automations/idempotency.ts`).

## UI integration

- **`src/components/ai/AiSummaryCard.tsx`** — the one reusable widget
  behind Customer Summary, Sales Summary, Follow-Up Suggestions, Product
  Sales Analysis, and Invoice/Account Summary. Never generates on page
  load (an explicit click is required, so viewing a page never silently
  spends an AI call); shows Summary and Recommendations as clearly
  separate sections, with the underlying Facts available in a collapsible
  `<details>` for full transparency. Mounted on the Company page
  (`src/app/(app)/companies/[id]/page.tsx`), the Dashboard
  (`src/app/(app)/dashboard/page.tsx`), and the Product detail page
  (`src/app/(app)/inventory/[id]/page.tsx`).
- **`src/components/ai/AiInventoryWarningButton.tsx`** — a compact
  inline "Explain" trigger next to each low-stock warehouse row on the
  Product detail page; only rendered for a row already at/below its
  reorder point.
- **`src/components/SendCommunicationForm.tsx`** — gained a "Draft with
  AI" button + intent selector (Follow-up / Confirmation / Quote) next to
  the existing template picker. It fills the same editable
  subject/body state a template would; nothing is sent until the human
  clicks Send, exactly like every other draft path in this app. A failed
  or unconfigured AI call shows an inline notice and leaves whatever the
  user had already typed untouched.
- **`/automations`** (`src/app/(app)/automations/page.tsx`) — gained
  "Failed AI generations" / "Recent AI generations" cards reading
  `AiGenerationLog` directly, the same admin-visibility pattern already
  used there for `AutomationJobRun` (`docs/AUTOMATION_SYSTEM.md`). This is
  the only administrative view into AI call history — there's no
  dedicated `/api/ai/*` failures endpoint or page (unlike
  `/api/automations/failures`); it's folded into the existing automations
  admin page since `/automations` is already an ADMIN-only page (no other
  role has the `automations` module).

## Configuration

`ANTHROPIC_API_KEY` (`.env.example`) — if unset, every AI route still
works and returns accurate facts, it just reports `aiAvailable: false`
with a clear "AI unavailable" message instead of a summary; nothing
crashes or silently disables the surrounding page. `ANTHROPIC_MODEL` is
an optional override (defaults to `claude-sonnet-5`,
`src/lib/ai/client.ts`).

## Testing & Verification

- `tests/ai-prompts.test.ts` — pure unit tests (no database) for the
  system prompt's safety-rule wording, per-feature prompt construction,
  and response parsing, including the malformed/non-JSON degradation
  path.
- `tests/ai-facts.test.ts` — the actual hallucination guardrail: proves
  each FACTS builder returns "No prior contact found" (or the
  feature-appropriate equivalent: "No inactive quotes", "no active
  low-stock warning", "No sales recorded", "No payments recorded") when
  the underlying data is genuinely empty, and the real detail once it
  exists.
- `tests/ai-service.test.ts` — `runAiSummaryFeature`/`runAiDraftFeature`
  with an injected `generate` stub (the same DI seam
  `sendCommunication()` uses for its email sender): proves a successful
  call writes a `SUCCESS` audit row and returns the model's parsed
  output, a failing/unconfigured call writes a `FAILED` audit row with
  the error message and degrades to `aiAvailable:false` without
  fabricating content, and a malformed AI response degrades gracefully
  rather than crashing.
- `tests/ai-routes.test.ts` — calls all seven route handlers directly
  (next-auth session stubbed to a fixed user, same pattern as
  `tests/route-idempotency.test.ts`) with no `ANTHROPIC_API_KEY`
  configured, and asserts that every mutable table this feature set reads
  from (Company, Contact, Invoice, Payment, Quote, SalesOrder,
  SalesOrderItem, Product, ProductVariant, StockLevel, StockMovement,
  Task, CommunicationLog) has an **identical** row count before and after
  all seven calls — the only table that changes is `AiGenerationLog`,
  by exactly one row per call. Also proves the double access-control gate
  (an ACCOUNTING session is blocked from product-analysis but allowed
  through invoice-summary).

Run: `npm run typecheck`, `npm test`, `npm run build`.
