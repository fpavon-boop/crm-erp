# CRM / ERP

A self-hosted CRM/ERP built with Next.js, TypeScript, Tailwind CSS, PostgreSQL, and Prisma —
customers, contacts, companies, suppliers, employees, sales pipeline, invoicing, purchasing,
inventory, tasks/calendar, a connected email inbox, WhatsApp Business messaging, and a
WordPress/WooCommerce integration, with role-based access and audit logging.

No real credentials or paid services are baked in — every third-party integration (email,
WhatsApp, WordPress) reads its credentials from environment variables you provide, and the app
runs and is fully usable with none of them configured.

## Features

- **Companies, contacts, employees & suppliers** — full profile (tax ID, address, phones,
  emails), notes, uploaded documents, communication history, linked invoices/orders, and a
  computed account balance.
- **Sales** — opportunities with a drag-and-drop Kanban pipeline, quotes, sales orders, and
  quote → order → invoice conversion.
- **Invoicing** — invoices, estimates, and receipts with taxes, discounts, payment tracking,
  downloadable PDFs, and one-click email delivery.
- **Purchasing** — purchase orders, goods receiving (with automatic inventory updates), and
  supplier invoices.
- **Inventory** — products, variants, multi-warehouse stock levels, movement history, manual
  adjustments, and low-stock detection.
- **Tasks & calendar** — a Kanban-style task board and an events calendar for follow-ups.
- **Dashboard** — revenue chart, unpaid invoices, pending orders, low-stock items, pending
  tasks.
- **Auth & roles** — email/password login (hashed with bcrypt), four roles (Administrator,
  Sales, Operations, Accounting) each with a different module access matrix.
- **Search, audit log, CSV export** — global search, a full audit trail of create/update/delete
  actions, and CSV export on every major list.
- **Automations** — built-in checks for overdue invoices (+ reminder emails), pending orders,
  low stock, and unanswered emails, each auto-creating a task; automatic inventory movements
  when orders are confirmed/shipped/cancelled or goods are received; automatic order
  confirmation emails; and a simple configurable rule engine ("when X happens, do Y").
- **Email inbox** — connect one or more IMAP/SMTP mailboxes, read and reply from inside the
  CRM, with every message auto-linked to the matching contact/company.
- **WhatsApp Business** — official Meta Cloud API only. View conversations per contact, send
  approved templates or free-form replies within the 24h window, and every inbound/outbound
  message is saved to the contact's history automatically via webhook.
- **WordPress integration** — syncs pages/posts/FAQs/services into a searchable knowledge base,
  imports contact-form leads (with consent + source tracking) into Contacts/Companies, and
  (optionally) syncs WooCommerce customers/products/orders. The knowledge base can suggest a
  draft reply for email — a human always reviews and sends it.

## Tech stack

Next.js 14 (App Router) · TypeScript · Tailwind CSS · PostgreSQL · Prisma · NextAuth
(credentials + JWT) · bcryptjs · pdfkit · nodemailer · imapflow · Meta WhatsApp Cloud API ·
WordPress REST API.

---

## 1. Local development

### Option A — Docker Compose (recommended)

```bash
cp .env.example .env
docker compose up --build
```

This starts PostgreSQL, runs the app on [http://localhost:3000](http://localhost:3000), and
(optionally) a background worker that runs automations every 15 minutes. First time only, run
migrations and seed a demo admin user:

```bash
docker compose exec app npx prisma migrate deploy
docker compose exec app npm run db:seed
```

Default seeded logins (change the password immediately in production):

| Role | Email | Password |
|---|---|---|
| Administrator | admin@example.com | ChangeMe123! |
| Sales | sales@example.com | ChangeMe123! |
| Operations | ops@example.com | ChangeMe123! |
| Accounting | accounting@example.com | ChangeMe123! |

### Option B — Node directly

Requires Node 20+ and a local/remote PostgreSQL instance.

```bash
cp .env.example .env         # edit DATABASE_URL etc.
npm install
npx prisma migrate dev
npm run db:seed
npm run dev
```

---

## 2. Environment variables

See [`.env.example`](.env.example) for the full list with comments. Key groups:

- **Core**: `DATABASE_URL`, `PORT`, `APP_URL`
- **Auth**: `NEXTAUTH_SECRET` (generate with `openssl rand -base64 32`), `NEXTAUTH_URL`
- **Uploads**: `UPLOADS_DIR` — mount a persistent volume here
- **Automations**: `CRON_SECRET` — required to call `POST /api/automations/run` externally
- **Outbound email**: `SMTP_*` — used for invoice delivery, payment reminders, order
  confirmations
- **Inbox encryption**: `IMAP_ENCRYPTION_KEY` — a 32-byte hex string (or any passphrase) used to
  encrypt stored mailbox/WhatsApp credentials at rest
- **WhatsApp**: `WHATSAPP_*` — see section 6
- **WordPress**: `WORDPRESS_*`, `WOOCOMMERCE_*` — see section 7

---

## 3. Database migrations

Schema changes live in [`prisma/schema.prisma`](prisma/schema.prisma).

```bash
npx prisma migrate dev --name <description>   # local development
npx prisma migrate deploy                      # production/CI — applies pending migrations only
```

`npm run build` runs `prisma generate` automatically; it does **not** run migrations. Always run
`prisma migrate deploy` yourself after deploying a new version with schema changes (see the
Easypanel steps below).

---

## 4. Production build & health check

```bash
npm run build
npm run start          # binds to 0.0.0.0:$PORT
```

`GET /api/health` returns `{ status: "ok", database: "connected" }` (200) or a 503 with the
error if the database is unreachable — point your platform's health check at this endpoint.

---

## 5. Deploying on Easypanel

Easypanel can build directly from this repository's `Dockerfile`.

### 5.1 Create the PostgreSQL service

1. In your Easypanel project, **+ Add Service → Postgres**.
2. Set a database name (e.g. `crm`), user, and password. Easypanel will give you an internal
   connection string / hostname (e.g. `crm-postgres`) — internal service-to-service traffic
   doesn't need to be exposed publicly.

### 5.2 Create the app service

1. **+ Add Service → App** (or "From a Git repository" / "From a Dockerfile").
2. Point it at this repository; Easypanel will detect the `Dockerfile` at the repo root and
   build it (multi-stage, produces the Next.js standalone runtime).
3. Under **Environment**, add every variable from `.env.example` with real values. At minimum:
   - `DATABASE_URL` = the internal Postgres connection string from step 5.1, e.g.
     `postgresql://crm:PASSWORD@crm-postgres:5432/crm?schema=public`
   - `NEXTAUTH_URL` / `APP_URL` = your public domain, e.g. `https://crm.yourdomain.com`
   - `NEXTAUTH_SECRET`, `CRON_SECRET`, `IMAP_ENCRYPTION_KEY` = random values
     (`openssl rand -base64 32` / `openssl rand -hex 32`)
   - `PORT` — Easypanel injects this automatically; the app already binds to
     `0.0.0.0:$PORT` (see `package.json`'s `start` script and the Dockerfile's `HOSTNAME`).
4. Under **Mounts / Volumes**, add a persistent volume mounted at `/app/uploads` (matches
   `UPLOADS_DIR` in `.env.example`) — this is where invoice PDFs, uploaded documents, and email
   attachments are stored. Without this, uploads are lost on every redeploy.
5. Set the **health check path** to `/api/health`.
6. Deploy.

### 5.3 Run migrations & seed (one-time, and after every schema change)

Use Easypanel's "Console"/"Shell" on the app service (or `docker exec` if you have server
access):

```bash
npx prisma migrate deploy
npm run db:seed        # optional — creates a demo admin user; edit SEED_ADMIN_* env vars first
```

**Change the seeded admin password immediately** (Settings → Users) or set `SEED_ADMIN_PASSWORD`
to something private before the first deploy.

### 5.4 Domain & SSL

In Easypanel, attach your domain to the app service and enable "Force HTTPS" — Easypanel
provisions a Let's Encrypt certificate automatically. Make sure `NEXTAUTH_URL` and `APP_URL`
match the final `https://` domain exactly (including no trailing slash), otherwise login
redirects will fail.

### 5.5 Automations scheduling

Automations (overdue-invoice reminders, low-stock/pending-order/unanswered-email tasks, and
email inbox sync) run **automatically every 15 minutes inside the app process** (see
`src/instrumentation.ts`) — no extra service needed. Tune with `AUTOMATIONS_INTERVAL_MINUTES`,
or set `DISABLE_INTERNAL_SCHEDULER=true` if you prefer an external trigger. They also run when
`POST /api/automations/run` is called. External options:

- **Easypanel Cron** (if available on your plan): schedule a job that runs, e.g. every 15
  minutes:
  ```bash
  curl -X POST https://crm.yourdomain.com/api/automations/run \
    -H "x-cron-secret: $CRON_SECRET"
  ```
- **The bundled worker service** in `docker-compose.yml` (`target: worker` in the Dockerfile)
  runs the same logic on an internal timer (`WORKER_INTERVAL_MINUTES`, default 15) without
  needing an external trigger — deploy it as a second Easypanel service from the same repo with
  the Dockerfile build target set to `worker`, if your Easypanel plan supports custom build
  targets. Otherwise, use the Cron option above.

---

## 6. WhatsApp Business setup (Meta Cloud API)

The CRM integrates **only** with the official WhatsApp Business Platform (Cloud API) — no
unofficial automation, no bulk/broadcast messaging outside Meta's own template-approval flow.

1. Create a [Meta Business account](https://business.facebook.com) and a
   [Meta App](https://developers.facebook.com/apps) with the **WhatsApp** product added.
2. Under **WhatsApp → API Setup**, note your:
   - **Phone number ID**
   - **WhatsApp Business Account ID**
   - Generate a **permanent access token** (Business Settings → System Users → create a system
     user with `whatsapp_business_messaging` + `whatsapp_business_management` permissions, then
     generate a token for it — this is more durable than the default 24h token).
3. In the CRM, go to **Settings → WhatsApp** (or `/whatsapp/settings`) and enter these three
   values plus a label. They're encrypted at rest using `IMAP_ENCRYPTION_KEY`.
   Alternatively/additionally, set `WHATSAPP_APP_ID`, `WHATSAPP_APP_SECRET`,
   `WHATSAPP_BUSINESS_ACCOUNT_ID`, `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_ACCESS_TOKEN` in `.env`.
4. **Webhook**: In the Meta App Dashboard → WhatsApp → Configuration, set the webhook URL to
   `https://crm.yourdomain.com/api/whatsapp/webhook` and the Verify Token to match
   `WHATSAPP_WEBHOOK_VERIFY_TOKEN` in your `.env`. Subscribe to the `messages` field. This is
   what lets inbound WhatsApp messages (and delivery/read receipts) appear automatically in the
   CRM and be saved to the right contact.
5. **Message templates**: create and submit templates for approval in Meta Business Manager
   (Business Settings → WhatsApp Accounts → Message Templates) for anything sent outside the 24h
   customer-service window — order confirmations, invoice/payment reminders, etc. Record the
   approved template names in the CRM under **Settings → WhatsApp** so they're selectable when
   sending.
6. Free-form text replies are only permitted within 24 hours of the customer's last inbound
   message, per WhatsApp policy — the CRM's compose box reflects this distinction (Text vs.
   Template) but does not attempt to bypass it.

No bulk messaging, opt-in harvesting, or contact-scraping automation is included, by design —
keeping usage inside Meta's Business Messaging Policy is your responsibility as the sender.

---

## 7. WordPress integration setup

1. In the CRM, go to **WordPress → Settings** and add your site's public URL (e.g.
   `https://www.yourbusiness.com`). Click **Sync content** to pull published pages/posts (and
   any `faq`/`service` custom post types your theme/plugins register) into the knowledge base.
   This uses the public REST API and requires no credentials — and only ever reads what's
   already publicly published, never drafts or private content.
2. For **authenticated** calls (WooCommerce sync, and to raise the WordPress REST API rate
   limits), create a WordPress **Application Password**: WP Admin → Users → your profile →
   Application Passwords → Add New. Put the username and generated password into
   `WORDPRESS_USERNAME` / `WORDPRESS_APP_PASSWORD` in `.env`.
3. **Leads from contact forms**: the CRM exposes
   `POST /api/wordpress/leads/webhook` (header `x-webhook-secret: $WORDPRESS_WEBHOOK_SECRET`).
   Point your form plugin's webhook feature at this URL:
   - **WPForms**: requires the [Webhooks addon] or a Zapier/Make bridge.
   - **Contact Form 7**: use the "CF7 to Webhook" or similar plugin.
   - **Gravity Forms**: built-in Webhooks add-on.

   Expected JSON body:
   ```json
   {
     "formName": "Contact Us",
     "sourceUrl": "https://www.yourbusiness.com/contact",
     "consent": true,
     "consentText": "I agree to be contacted about my inquiry.",
     "fields": { "name": "Jane Doe", "email": "jane@example.com", "phone": "+1...", "message": "..." }
   }
   ```
   The CRM creates/updates the matching Contact (and Company, if a `company` field is present),
   and always records the source page, submission date, and the consent flag/text exactly as
   sent — it never infers or assumes consent.
4. **WooCommerce** (optional): if the site runs WooCommerce, create REST API keys
   (WooCommerce → Settings → Advanced → REST API → Add key, permissions "Read"), and set
   `WOOCOMMERCE_CONSUMER_KEY` / `WOOCOMMERCE_CONSUMER_SECRET`. Then click **Sync WooCommerce** on
   the WordPress settings page to import customers, products (with stock levels), and orders.
5. **Drafting replies from the knowledge base**: on any email in the Inbox, click "Suggest reply
   from knowledge base" — this searches synced WordPress content for relevant snippets and
   drafts a starting point. It is never sent automatically; a staff member must review, edit,
   and click Send.
6. **Privacy**: only public content is crawled; the CRM stores no more personal data from leads
   than the form itself submits, plus the consent flag/date/source required to demonstrate
   lawful basis for contact. Delete a `WordPressLead` (and its linked Contact, if applicable)
   the same way you would any other record if someone exercises a deletion request.

---

## 8. Email inbox setup

Each user connects their own mailbox from **Settings → Email Accounts** (or `/inbox/accounts`)
with standard IMAP (read) + SMTP (send) credentials. For Gmail/Outlook/Yahoo, use an
app-specific password, not your normal login password. Credentials are encrypted at rest with
`IMAP_ENCRYPTION_KEY`.

Click **Sync now**, or wait for the automations worker/cron to sync automatically. New inbound
messages are matched to a Contact/Company by sender email (falling back to domain match against
a Company's website), saved to that record's communication history, and — if unanswered after 24
hours — a follow-up task is auto-created.

---

## 9. Roles & permissions

| Module | Administrator | Sales | Operations | Accounting |
|---|:---:|:---:|:---:|:---:|
| Dashboard | ✅ | ✅ | ✅ | ✅ |
| Companies / Contacts | ✅ | ✅ | ✅ | ✅ |
| Employees | ✅ | — | ✅ | — |
| Sales (pipeline, quotes, orders) | ✅ | ✅ | ✅ | — |
| Invoicing | ✅ | ✅ | — | ✅ |
| Purchasing | ✅ | — | ✅ | ✅ |
| Inventory | ✅ | ✅ | ✅ | — |
| Tasks / Calendar | ✅ | ✅ | ✅ | ✅ |
| Email Inbox | ✅ | ✅ | ✅ | ✅ |
| WhatsApp | ✅ | ✅ | ✅ | — |
| WordPress | ✅ | ✅ | ✅ | — |
| Automations | ✅ | — | — | — |
| Users & Settings | ✅ | — | — | — |

Adjust the matrix in [`src/lib/permissions.ts`](src/lib/permissions.ts).

---

## 10. API

Every module has a documented REST-ish API under `/api/*`, protected by the same session/role
checks as the UI (`src/lib/api-auth.ts`). Highlights:

- `GET /api/health` — liveness + DB connectivity check
- `GET/POST /api/companies`, `/api/contacts`, `/api/products`, … — standard list/create
- `GET/PUT/DELETE /api/companies/:id`, etc. — standard read/update/delete
- `?format=csv` on any list endpoint — CSV export
- `POST /api/sales-orders/:id/status` — change order status (triggers inventory movements +
  confirmation email)
- `POST /api/invoices/:id/pdf` (GET) — download PDF; `POST /api/invoices/:id/send` — email it;
  `POST /api/invoices/:id/payments` — record a payment
- `POST /api/purchase-orders/:id/receive` — record a goods receipt (creates inventory IN
  movements)
- `POST /api/automations/run` — trigger all scheduled automations (cron secret or admin session)
- `POST /api/whatsapp/webhook`, `GET /api/whatsapp/webhook` — Meta webhook receiver/verification
- `POST /api/wordpress/leads/webhook` — WordPress form-lead intake

---

## 11. Security notes

- Passwords are hashed with bcrypt; sessions are signed JWTs (`NEXTAUTH_SECRET`).
- Third-party credentials (mailbox passwords, WhatsApp access tokens) are encrypted at rest with
  AES-256-GCM (`IMAP_ENCRYPTION_KEY`) — never stored or logged in plain text.
- `CRON_SECRET` gates the automations endpoint from public invocation.
- `WORDPRESS_WEBHOOK_SECRET` gates the lead-intake webhook.
- `WHATSAPP_WEBHOOK_VERIFY_TOKEN` gates the WhatsApp webhook handshake.
- Change every default/example secret before deploying to production — none of the values in
  `.env.example` are safe to use as-is.
