# Customer Communication (Email & WhatsApp)

**Date:** 2026-09-25 (Phase 10)
**Status:** Implemented and tested. This document is the explicit behavior —
code should match this, not the other way around.

## What this is

A unified way to see and send customer-facing communication (email and
WhatsApp) from the Company and Sales Order pages, built on top of the
existing email (IMAP/SMTP) and WhatsApp (Meta Cloud API) integrations —
this phase adds no new external provider, no new credentials, and no
changes to WhatsApp/email account configuration. It adds:

1. A unified communication timeline on Company and Sales Order pages.
2. Seven standard message templates, always shown as an editable draft the
   user reviews and edits before a human clicks Send.
3. An audit log entry for every outbound email/WhatsApp send this app
   makes — the new manual flow and the pre-existing automated senders
   (payment reminders, order confirmations, invoice delivery) alike.

## Supported channels

- **Email**, via the existing `sendSystemEmail()` (`src/lib/email/smtp.ts`)
  — system SMTP if configured, else the first connected mailbox.
- **WhatsApp**, via the existing `sendText()` (`src/lib/whatsapp/client.ts`)
  — a free-form message through the active `WhatsAppAccount`.

No new channel, provider, or account type was added. `Order confirmation`,
`Payment confirmation`, `Payment reminder`, `Shipping notification`,
`Delivery notification`, and `Quote follow-up` are offered on both
channels; `Invoice send` is email-only (it corresponds to the existing
PDF-attached invoice delivery, which has no WhatsApp equivalent).

### WhatsApp constraints (unchanged, not something this phase can lift)

A free-form WhatsApp message (`sendText`, what every template uses here)
can only be delivered within Meta's 24-hour customer-service window —
i.e. the customer must have messaged the business number in the last 24
hours. Sending outside that window requires a message template
pre-registered and approved in Meta Business Manager (`sendTemplate()`),
which is a different, slower-moving artifact than the 7 editable
templates this phase adds, and altering WhatsApp provider/template
configuration was explicitly out of scope for this phase. The Send form
shows a warning when WhatsApp is selected so this isn't a surprise at
send time.

## The 7 templates and their variable bindings

Defined in `src/lib/communications/templates.ts`. Each is a pure function
`(context) => { subject, body }` — nothing about rendering a template
sends anything.

| Template key | Channels | Variables used (when available) |
|---|---|---|
| `order_confirmation` | email, whatsapp | recipientName, orderNumber, orderTotal |
| `payment_confirmation` | email, whatsapp | recipientName, paymentAmount, paymentMethod, invoiceNumber |
| `invoice_send` | email | recipientName, invoiceNumber, invoiceTotal, dueDate |
| `payment_reminder` | email, whatsapp | recipientName, invoiceNumber, balanceDue, dueDate |
| `shipping_notification` | email, whatsapp | recipientName, orderNumber |
| `delivery_notification` | email, whatsapp | recipientName, orderNumber |
| `quote_follow_up` | email, whatsapp | recipientName, quoteNumber, quoteTotal |

Every variable is optional in the render context — a template renders a
natural draft with or without a specific order/invoice/quote attached (see
`ref()` in `templates.ts`), because the Company page's Send form has no
specific record selected (context is just the customer's name), while the
Sales Order page's Send form has the full order/invoice/quote context
available and interpolates all of it.

`shipping_notification` deliberately leaves a `[Add carrier / tracking
number here before sending]` placeholder — there is no carrier/tracking
field anywhere in this schema, so the human filling in the draft supplies
it, rather than the template fabricating one.

## The human-approval / manual-send workflow

Every template-driven send goes through `SendCommunicationForm`
(`src/components/SendCommunicationForm.tsx`) → `POST
/api/communications/send` → `sendCommunication()`
(`src/lib/communications/send.ts`). There is no code path that sends one
of these 7 templates without a human first seeing the rendered draft in an
editable textarea and clicking Send — picking a template only swaps the
draft shown; nothing is sent until the explicit submit.

This is unchanged for the pre-existing automated senders
(`sendPaymentReminder`, `sendOrderConfirmation`, `sendInvoiceByEmail` in
`src/lib/automations/notifications.ts`) — those already had their own
business rule (an overdue invoice, a newly-confirmed order, an explicit
"Send invoice" click) before this phase, and continue to run exactly as
before. This phase only adds audit logging to them (see below); it does
not add any new automatic trigger.

## Outbound message audit logging

Every outbound email/WhatsApp send this app makes — both the new manual
template flow and the pre-existing automated senders — writes exactly one
`CommunicationLog` row (`src/lib/communications/log.ts`'s
`recordCommunication()`), whether the send succeeded or failed. This is
deliberate: a failed send is never silently lost, the same "no invisible
failures" discipline `docs/SYSTEM_AUDIT.md` C3 already established for the
WhatsApp webhook. `sendSystemEmail()`'s underlying transport can throw (a
DNS failure, an SMTP auth rejection) rather than return `{sent: false}` —
`sendAndRecord()` in `notifications.ts` and `sendCommunication()` in
`communications/send.ts` both catch that and still log a `FAILED` row
instead of letting the error skip the audit write.

### Schema

`CommunicationLog` (`prisma/schema.prisma`), extended this phase with:

| Column | Meaning |
|---|---|
| `recipient` | The email address or phone number actually used |
| `templateKey` | Which of the 7 templates produced this (null for ad-hoc/system) |
| `status` | `'SENT'` \| `'FAILED'` for an outbound attempt; null for inbound rows |
| `relatedType` / `relatedId` | The specific business record this is about (e.g. `SALES_ORDER` / that order's id) — same generic pattern `Note`/`Document` already use |
| `companyId` / `contactId` | Which customer this is about (pre-existing) |
| `userId` | Who sent it — the signed-in user for a manual send, null for an automated one |
| `occurredAt` | Timestamp (pre-existing) |

Migration `20260925030000_communication_log_audit` is purely additive —
five new nullable columns and one new index; no existing row is touched.

### Where the timeline is shown

- **Company page** (`src/app/(app)/companies/[id]/page.tsx`): the existing
  "Communication history" card now also shows the send form and each
  entry's status/template/linked-record badges.
- **Sales Order page** (`src/app/(app)/sales/orders/[id]/page.tsx`): a new
  "Communication" card, scoped to `relatedType: 'SALES_ORDER', relatedId:
  <this order>` — only messages explicitly sent about this order, not
  every message ever sent to its customer.

## Security considerations

- **No credentials ever leave the server.** `decryptSecret()` (email/
  WhatsApp account passwords and access tokens) is only ever called inside
  `src/lib/email/smtp.ts` and `src/lib/whatsapp/client.ts`, server-side;
  neither `POST /api/communications/send`'s response nor any
  `CommunicationLog` row ever contains an account's `encryptedPassword`,
  `encryptedAccessToken`, host, or username — verified directly in
  `tests/communications-send.test.ts`'s "credentials never leak" suite.
- **Role-based sending.** `POST /api/communications/send` requires the
  `inbox` module for an email send and the `whatsapp` module for a
  WhatsApp send — the same module gates every other email/WhatsApp action
  in this app already uses (`src/lib/permissions.ts`). The Send form only
  offers a channel the viewer's role can actually use.
- **No new external exposure.** This phase adds no new public/unauthenticated
  route — `POST /api/communications/send` sits behind the same
  `requireApiModule()` auth every other authenticated API route uses.

## Testing

- `tests/communication-templates.test.ts` — pure-function tests: all 7
  templates render without throwing, interpolate their variables
  correctly, degrade gracefully with no record-specific context, and
  `textToHtml()` escapes HTML-significant characters.
- `tests/communications-send.test.ts` — database-backed: a successful send
  writes one `SENT` audit row with recipient/channel/template/sentBy/
  timestamp; a failed send (including a thrown transport error) writes one
  `FAILED` row instead of being lost; the pre-existing automated senders
  also log every attempt now; email/WhatsApp sending permission checks
  match the existing module matrix; no credential-shaped data appears in a
  send result or a logged row.
