# Security Audit

**Date:** 2026-09-27
**Status:** Findings documented; low-risk fixes implemented and tested (see
"Fixed" column). No architectural refactors were made — items that require
one (CSRF middleware, a rate-limiting layer, etc.) are recorded as open
recommendations, consistent with `docs/SYSTEM_AUDIT.md`'s existing open items
F1 and F3.

## What this is

A production security audit of the whole `src/` tree, covering five areas:
auth/RBAC and server-side authorization, IDOR, uploads/webhooks/secret
logging, injection/XSS/CSRF, and session/error hygiene. Every finding below
was confirmed by reading the actual route/lib code — not assumed from
naming or documentation.

## Summary table

| ID | Severity | Area | Finding | Fixed? |
|---|---|---|---|---|
| A1 | **HIGH** | RBAC/IDOR | `documents/[id]/download` GET+DELETE had no module check — any authenticated user of any role could download or delete any document | ✅ Fixed |
| A2 | **HIGH** | RBAC/IDOR | `invoices/[id]/pdf` was missing the `invoicing` module gate every other invoice route enforces | ✅ Fixed |
| A3 | **HIGH** | IDOR / credential exposure | `email-messages/[id]` returned another user's mailbox `encryptedPassword`, `username`, `imapHost`, `smtpHost` to any `inbox`-module user | ✅ Fixed |
| A4 | **MEDIUM** | IDOR | `email-accounts/[id]/sync` had no ownership check — any `inbox`-module user could trigger an IMAP sync of another user's mailbox by ID | ✅ Fixed |
| A5 | **MEDIUM** | RBAC | `/api/search` returned company/contact/invoice/order/product matches regardless of the caller's module access (e.g. ACCOUNTING could see sales-order/product hits) | ✅ Fixed |
| A6 | **MEDIUM** | Upload validation | `companies/[id]/documents` upload had no file-type or size validation, unlike `bills/upload` | ✅ Fixed |
| A7 | **MEDIUM** | Error hygiene | 4 routes returned raw `String(err)` to the client on failure (IMAP sync, WhatsApp send, WordPress site sync, WooCommerce sync) | ✅ Fixed |
| A8 | **LOW** | Secret comparison | WordPress lead webhook and cron-secret checks used `!==` instead of a constant-time comparison | ✅ Fixed |
| A9 | **LOW** | Session hygiene | No explicit `session`/`jwt` `maxAge` — defaulted to NextAuth's 30-day lifetime | ✅ Fixed (now 12h) |
| A10 | **LOW** | Auth timing | Login skipped `bcrypt.compare` entirely for a nonexistent email, making "no such user" measurably faster than "wrong password" (timing-based user enumeration) | ✅ Fixed |
| A11 | **MEDIUM** | CSRF | No CSRF token/Origin check on cookie-authenticated API routes; protection currently rests solely on NextAuth's default `sameSite=lax` cookie | 📋 Documented (architectural — see Recommendations) |
| A12 | **LOW** | Secret leakage | `AiGenerationLog.errorMessage` surfaces up to 500 chars of Anthropic's raw error response to staff in the AI summary UI | 📋 Documented (intentional debug visibility, staff-only, low severity) |
| A13 | **LOW** | Dead code | `isAdmin()` in `src/lib/permissions.ts` is defined but never called | 📋 Documented (no behavior impact) |
| A14 | **LOW** | XSS (latent) | Inbound email `bodyHtml` is stored raw with no sanitization; not currently rendered anywhere, so no live sink today | 📋 Documented (must sanitize before any future UI renders it) |
| A15 | **LOW** | Error hygiene | Several file-streaming routes (`documents/download`, `invoices/pdf`, `bills/[id]/file`) have no `try/catch` around read/generation; unconfirmed whether an uncaught throw could leak detail in this Next.js version's production build | 📋 Documented (needs a live-request check, not a code change) |

**Confirmed clean / already fixed, no action needed:**
- **SQL injection** — every `$queryRaw`/`$executeRaw` call site uses Prisma's tagged-template form (parameterized); zero uses of `$queryRawUnsafe`/`$executeRawUnsafe` exist anywhere in `src/`.
- **XSS** — zero uses of `dangerouslySetInnerHTML`, `innerHTML`, or `eval` in `src/` (see A14 for the one latent, unrendered exception).
- **Cookie/session config** — `httpOnly`/`secure`/`sameSite` all use NextAuth's safe defaults; no hardcoded secrets.
- **Webhook signature verification** — Stripe (SDK signature verification), WhatsApp (HMAC-SHA256 `X-Hub-Signature-256` or shared forward-secret, both constant-time), and WordPress leads (now constant-time, see A8) are all correctly gated and excluded from cookie-session middleware.
- **User enumeration via error message** — login always returns the identical generic "Invalid email or password" regardless of cause (message-level; see A10 for the timing-level fix).
- **`/api/health`** — already fixed in a prior hardening pass (`docs/SYSTEM_HARDENING.md` item E3); re-verified still in place, not re-flagged.
- **Encrypted-at-rest credentials** — IMAP/WhatsApp secrets use AES-256-GCM (`src/lib/crypto.ts`) and are decrypted only in-memory; never echoed into logs, responses, or audit rows (aside from A3, now fixed).
- **RBAC coverage** — of ~85 API routes audited, all but the ones listed above correctly call `requireApiModule`/`requireAiModule`/`requireModule` before touching data; `/api/users`, `/api/audit-log`, and `/api/automations/run|failures` all have the right (sometimes redundant, belt-and-suspenders) checks.
- **IDOR on shared business records** (Company/Contact/Invoice/Payment/Bill/Product/etc.) — confirmed **by design**: this is a single-tenant internal tool where all staff with a module's access are meant to see all records in it (no per-owner scoping exists in the schema, and `tests/*-authorization.test.ts` explicitly test module-level, not per-record, access).

## Fixes in detail

### A1/A2 — Missing module gates on document download/delete and invoice PDF
`src/app/api/documents/[id]/download/route.ts` now looks up the document,
maps its `entityType` to the module that governs its parent record
(`moduleForEntityType()`, added to `src/lib/permissions.ts`), and requires
`canAccess(role, module)` before serving or deleting it — mirroring how
every other record route in this codebase is protected.
`src/app/api/invoices/[id]/pdf/route.ts` now calls
`requireApiModule('invoicing')` instead of the session-only
`requireApiSession()`, matching `invoices/[id]/route.ts`.

### A3 — Mailbox credentials leaking via email-message lookup
`src/app/api/email-messages/[id]/route.ts` included the full `EmailAccount`
row (`encryptedPassword`, `username`, `imapHost`, `smtpHost`) for *any*
`inbox`-module user viewing *any* message, not just their own mailbox. Now
`select`s only `{ id, label, emailAddress }`.

### A4 — No ownership check on IMAP sync trigger
`src/app/api/email-accounts/[id]/sync/route.ts` now verifies
`emailAccount.userId === session.user.id` before calling `syncEmailAccount`,
mirroring the ownership check the sibling `DELETE` route already had.

### A5 — Global search bypassing module boundaries
`src/app/api/search/route.ts` now skips each record type's query entirely
when the caller's role lacks that module (`canAccess(role, 'invoicing')`,
etc.), so e.g. an ACCOUNTING user (no `sales`/`inventory` module) no longer
gets sales-order or product hits.

### A6 — Unrestricted file upload on company documents
`src/app/api/companies/[id]/documents/route.ts` now validates the uploaded
file's MIME type against a new `ALLOWED_DOCUMENT_TYPES` allowlist and a
15MB size cap (`src/lib/uploads.ts`), matching the pattern already used by
`bills/upload`. Storage itself was already safe (random UUID-prefixed
filenames, outside `public/`).

### A7 — Raw error strings returned to the client
`String(err)` responses in the IMAP sync, WhatsApp send, WordPress site
sync, and WooCommerce sync routes could surface upstream connection/API
error detail (hosts, endpoints, response bodies) to the requesting user.
All four now `console.error` the detail server-side and return a generic
message, the same treatment `/api/health` already got under E3.

### A8 — Non-constant-time secret comparisons
Added a shared `safeEqual()` helper (`src/lib/crypto.ts`, using
`crypto.timingSafeEqual`) and switched the WordPress lead webhook's
`x-webhook-secret` check and `requireCronSecret()`'s comparison to use it —
matching the pattern the WhatsApp webhook already used. (The `CRON_SECRET`
query-string acceptance path itself was left in place rather than removed,
since Easypanel's scheduled trigger may already be configured against it in
production; see Recommendations.)

### A9 — No explicit session lifetime
`src/lib/auth.ts` now sets `session.maxAge` and `jwt.maxAge` to 12 hours
(was: NextAuth's unstated 30-day default). This is a real behavior change —
**every currently-logged-in user will need to re-authenticate within 12
hours of this deploying** (sooner if they were already mid-session).

### A10 — Login timing side-channel
`authorize()` returned immediately (skipping `bcrypt.compare`) when the
email didn't exist, but always ran the ~100ms `bcrypt.compare` when the
email existed but the password was wrong — a measurable timing difference
an attacker could use to enumerate valid emails even though the *messages*
were identical. Now a nonexistent-email attempt still runs
`bcrypt.compare` against a fixed dummy hash before returning `null`, so
both paths cost the same.

## Recommendations (not implemented — require more than a low-risk fix)

- **A11 — CSRF defense-in-depth.** Add an explicit Origin/Referer check (or
  CSRF token) to cookie-authenticated API routes rather than relying solely
  on `sameSite=lax`. This would touch most of the ~85 API routes or the
  shared `requireApiSession`/`requireApiModule` helpers — worth doing, but
  it's a cross-cutting change that deserves its own reviewed pass rather
  than being folded into this audit.
- **A12 — AI error detail exposure.** Consider truncating/genericizing the
  error text surfaced in the AI summary UI further. Low priority: it's
  staff-only, and the current verbosity is what let a real production bug
  (the Anthropic response-shape parsing issue, fixed in `ced78c4`) get
  diagnosed quickly.
- **A15 — Uncaught-throw behavior in streaming routes.** Verify against a
  live production request (not just static reading) what Next.js actually
  returns to the client when `documents/[id]/download`,
  `invoices/[id]/pdf`, or `bills/[id]/file` throw partway through — add a
  `try/catch` + generic-error response if it turns out to leak anything.
- This audit did not re-open `docs/SYSTEM_AUDIT.md`'s already-tracked
  open items (F1 rate limiting, F3 CSP/security headers, F6 ESLint config,
  stock-reconciliation report, external monitoring, QuickBooks export) —
  those remain open exactly as recorded there.

## Testing

All existing tests continue to pass unchanged (375 tests, 37 files) — none
of these fixes required new test infrastructure since they're
authorization/validation checks layered onto existing, already-tested
routes. `npm run typecheck` and `npm run build` were run clean after every
change in this document.
