import { money, formatDate } from '@/lib/format';

/**
 * The 7 standard message templates (Phase 10 — docs/CUSTOMER_COMMUNICATION.md).
 * Every template is a pure function of already-known business data to a
 * plain-text draft — nothing here sends anything. The caller (a human, via
 * the Send Communication form) always sees the rendered draft and can edit
 * it before actually sending; see src/lib/communications/send.ts for the
 * send step itself.
 */
export const TEMPLATE_KEYS = [
  'order_confirmation',
  'payment_confirmation',
  'invoice_send',
  'payment_reminder',
  'shipping_notification',
  'delivery_notification',
  'quote_follow_up',
] as const;

export type TemplateKey = (typeof TEMPLATE_KEYS)[number];

export type TemplateChannel = 'email' | 'whatsapp';

export interface TemplateDefinition {
  key: TemplateKey;
  label: string;
  /** Which channels this template makes sense on. WhatsApp delivery of any
   * of these is only possible within Meta's 24-hour customer-service
   * window unless the exact text has separately been registered and
   * approved as a WhatsApp template with Meta — see
   * docs/CUSTOMER_COMMUNICATION.md "WhatsApp constraints". */
  channels: TemplateChannel[];
}

export const TEMPLATE_DEFINITIONS: Record<TemplateKey, TemplateDefinition> = {
  order_confirmation: { key: 'order_confirmation', label: 'Order confirmation', channels: ['email', 'whatsapp'] },
  payment_confirmation: { key: 'payment_confirmation', label: 'Payment confirmation', channels: ['email', 'whatsapp'] },
  invoice_send: { key: 'invoice_send', label: 'Invoice send', channels: ['email'] },
  payment_reminder: { key: 'payment_reminder', label: 'Payment reminder', channels: ['email', 'whatsapp'] },
  shipping_notification: { key: 'shipping_notification', label: 'Shipping notification', channels: ['email', 'whatsapp'] },
  delivery_notification: { key: 'delivery_notification', label: 'Delivery notification', channels: ['email', 'whatsapp'] },
  quote_follow_up: { key: 'quote_follow_up', label: 'Quote follow-up', channels: ['email', 'whatsapp'] },
};

/**
 * Everything a template might interpolate — a superset across all 7
 * templates. Each render function only reads the fields it needs; nothing
 * requires every field to be present (a quote follow-up doesn't need an
 * invoice number, for instance).
 */
export interface CommunicationTemplateContext {
  recipientName: string;
  orderNumber?: string | null;
  orderTotal?: number | null;
  invoiceNumber?: string | null;
  invoiceTotal?: number | null;
  balanceDue?: number | null;
  dueDate?: Date | null;
  quoteNumber?: string | null;
  quoteTotal?: number | null;
  paymentAmount?: number | null;
  paymentMethod?: string | null;
}

export interface RenderedTemplate {
  subject: string | null;
  body: string;
}

function greeting(ctx: CommunicationTemplateContext): string {
  return `Hi ${ctx.recipientName || 'there'},`;
}

/** "order SO-1234" when a number is known, "your order" when it isn't (the
 * company-level Send form has no specific order/invoice/quote selected) —
 * every template reads naturally either way, rather than leaving a blank
 * or a literal "undefined" in the draft. */
function ref(noun: string, number: string | null | undefined): string {
  return number ? `${noun} ${number}` : `your ${noun}`;
}

const RENDERERS: Record<TemplateKey, (ctx: CommunicationTemplateContext) => RenderedTemplate> = {
  order_confirmation: (ctx) => ({
    subject: ctx.orderNumber ? `Order confirmation ${ctx.orderNumber}` : 'Order confirmation',
    body: [
      greeting(ctx),
      `${ref('Order', ctx.orderNumber)} has been confirmed.`,
      ctx.orderTotal != null ? `Order total: ${money(ctx.orderTotal)}.` : null,
      `We'll let you know as soon as it ships. Thank you for your business.`,
    ]
      .filter(Boolean)
      .join('\n\n'),
  }),
  payment_confirmation: (ctx) => ({
    subject: ctx.invoiceNumber ? `Payment received — Invoice ${ctx.invoiceNumber}` : 'Payment received',
    body: [
      greeting(ctx),
      `We've received your payment${ctx.paymentAmount != null ? ` of ${money(ctx.paymentAmount)}` : ''}${ctx.paymentMethod ? ` via ${ctx.paymentMethod}` : ''} for ${ref('invoice', ctx.invoiceNumber)}.`,
      `Thank you — this has been applied to your account.`,
    ]
      .filter(Boolean)
      .join('\n\n'),
  }),
  invoice_send: (ctx) => ({
    subject: ctx.invoiceNumber ? `Invoice ${ctx.invoiceNumber}` : 'Your invoice',
    body: [
      greeting(ctx),
      `Please find ${ref('invoice', ctx.invoiceNumber)}${ctx.invoiceTotal != null ? ` for a total of ${money(ctx.invoiceTotal)}` : ''} attached/linked below.`,
      ctx.dueDate ? `Payment is due by ${formatDate(ctx.dueDate)}.` : null,
      `Thank you for your business.`,
    ]
      .filter(Boolean)
      .join('\n\n'),
  }),
  payment_reminder: (ctx) => ({
    subject: ctx.invoiceNumber ? `Payment reminder: Invoice ${ctx.invoiceNumber}` : 'Payment reminder',
    body: [
      greeting(ctx),
      `This is a friendly reminder that ${ref('invoice', ctx.invoiceNumber)}${ctx.balanceDue != null ? ` for ${money(ctx.balanceDue)}` : ''}${ctx.dueDate ? ` was due on ${formatDate(ctx.dueDate)}` : ''} is still unpaid.`,
      `Please arrange payment at your earliest convenience, or let us know if you have any questions.`,
    ]
      .filter(Boolean)
      .join('\n\n'),
  }),
  shipping_notification: (ctx) => ({
    subject: ctx.orderNumber ? `Your order ${ctx.orderNumber} has shipped` : 'Your order has shipped',
    body: [
      greeting(ctx),
      `Good news — ${ref('order', ctx.orderNumber)} is on its way.`,
      `[Add carrier / tracking number here before sending]`,
    ]
      .filter(Boolean)
      .join('\n\n'),
  }),
  delivery_notification: (ctx) => ({
    subject: ctx.orderNumber ? `Your order ${ctx.orderNumber} has been delivered` : 'Your order has been delivered',
    body: [
      greeting(ctx),
      `${ref('Order', ctx.orderNumber)} has been marked as delivered.`,
      `Please let us know if anything isn't as expected — we're happy to help.`,
    ]
      .filter(Boolean)
      .join('\n\n'),
  }),
  quote_follow_up: (ctx) => ({
    subject: ctx.quoteNumber ? `Following up on quote ${ctx.quoteNumber}` : 'Following up on your quote',
    body: [
      greeting(ctx),
      `I wanted to follow up on ${ref('quote', ctx.quoteNumber)}${ctx.quoteTotal != null ? ` (${money(ctx.quoteTotal)})` : ''} we sent over.`,
      `Happy to answer any questions or make adjustments — just let us know how you'd like to proceed.`,
    ]
      .filter(Boolean)
      .join('\n\n'),
  }),
};

export function renderTemplate(key: TemplateKey, context: CommunicationTemplateContext): RenderedTemplate {
  return RENDERERS[key](context);
}

/** Renders every template up front for one context — used server-side to
 * hand a "Send communication" form every draft it might need, so switching
 * the template picker client-side is an instant local state swap with no
 * round trip (the context itself, e.g. which order/invoice this is about,
 * doesn't change within one form). */
export function renderAllTemplates(context: CommunicationTemplateContext): Record<TemplateKey, RenderedTemplate> {
  const result = {} as Record<TemplateKey, RenderedTemplate>;
  for (const key of TEMPLATE_KEYS) {
    result[key] = renderTemplate(key, context);
  }
  return result;
}

/** Plain-text draft -> minimal HTML for email sending: paragraphs split on
 * blank lines, HTML-escaped so nothing in a customer name/order number can
 * break out of the markup. */
export function textToHtml(text: string): string {
  const escape = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return text
    .split(/\n\s*\n/)
    .map((para) => `<p>${escape(para).replace(/\n/g, '<br/>')}</p>`)
    .join('');
}
