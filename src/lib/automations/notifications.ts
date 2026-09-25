import type { RelatedEntityType } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { sendSystemEmail } from '@/lib/email/smtp';
import { renderInvoicePdf } from '@/lib/pdf';
import { recordCommunication } from '@/lib/communications/log';

function recipientEmail(invoiceOrOrder: {
  contact?: { email: string | null } | null;
  company?: { emails?: { address: string }[] } | null;
}): string | null {
  if (invoiceOrOrder.contact?.email) return invoiceOrOrder.contact.email;
  const first = invoiceOrOrder.company?.emails?.[0]?.address;
  return first || null;
}

/**
 * Sends via sendSystemEmail and always writes one CommunicationLog row
 * afterward — including when the transport itself throws (a DNS failure,
 * an auth rejection), which sendSystemEmail does not catch. Without this,
 * a misconfigured/unreachable SMTP server would make the send attempt
 * vanish with no record anywhere, the same "invisible failure" class
 * SYSTEM_AUDIT.md C3 already flagged for the WhatsApp webhook. Every
 * automated notification sender in this file goes through this one
 * function so that guarantee only has to be true in one place.
 */
async function sendAndRecord(opts: {
  to: string;
  subject: string;
  html: string;
  attachments?: { filename: string; content: Buffer }[];
  templateKey: string;
  companyId: string | null;
  contactId: string | null;
  relatedType: RelatedEntityType;
  relatedId: string;
}): Promise<{ sent: boolean; reason?: string }> {
  let result: { sent: boolean; reason?: string };
  try {
    result = await sendSystemEmail({ to: opts.to, subject: opts.subject, html: opts.html, attachments: opts.attachments });
  } catch (err) {
    result = { sent: false, reason: err instanceof Error ? err.message : String(err) };
  }
  await recordCommunication({
    type: 'EMAIL',
    subject: opts.subject,
    body: opts.html,
    recipient: opts.to,
    templateKey: opts.templateKey,
    status: result.sent ? 'SENT' : 'FAILED',
    companyId: opts.companyId,
    contactId: opts.contactId,
    relatedType: opts.relatedType,
    relatedId: opts.relatedId,
  });
  return result;
}

export async function sendInvoiceByEmail(invoiceId: string) {
  const invoice = await prisma.invoice.findUniqueOrThrow({
    where: { id: invoiceId },
    include: { items: true, company: { include: { emails: true } }, contact: true },
  });

  const to = recipientEmail(invoice);
  if (!to) return { sent: false, reason: 'No recipient email on file' };

  const pdf = await renderInvoicePdf({
    number: invoice.number,
    type: invoice.type,
    issueDate: invoice.issueDate,
    dueDate: invoice.dueDate,
    status: invoice.status,
    company: invoice.company,
    contact: invoice.contact,
    items: invoice.items.map((i) => ({
      description: i.description,
      quantity: Number(i.quantity),
      unitPrice: Number(i.unitPrice),
      taxRate: Number(i.taxRate),
      discount: Number(i.discount),
    })),
    subtotal: Number(invoice.subtotal),
    taxTotal: Number(invoice.taxTotal),
    discountTotal: Number(invoice.discountTotal),
    total: Number(invoice.total),
    amountPaid: Number(invoice.amountPaid),
    notes: invoice.notes,
  });

  const subject = `${invoice.type === 'INVOICE' ? 'Invoice' : invoice.type === 'ESTIMATE' ? 'Estimate' : 'Receipt'} ${invoice.number}`;
  const html = `<p>Hello,</p><p>Please find attached your ${invoice.type.toLowerCase()} <b>${invoice.number}</b> for a total of $${Number(invoice.total).toFixed(2)}.</p><p>Thank you for your business.</p>`;
  return sendAndRecord({
    to,
    subject,
    html,
    attachments: [{ filename: `${invoice.number}.pdf`, content: pdf }],
    templateKey: 'invoice_send',
    companyId: invoice.companyId,
    contactId: invoice.contactId,
    relatedType: 'INVOICE',
    relatedId: invoice.id,
  });
}

export async function sendPaymentReminder(invoiceId: string) {
  const invoice = await prisma.invoice.findUniqueOrThrow({
    where: { id: invoiceId },
    include: { company: { include: { emails: true } }, contact: true },
  });
  const to = recipientEmail(invoice);
  if (!to) return { sent: false, reason: 'No recipient email on file' };

  const balance = Number(invoice.total) - Number(invoice.amountPaid);
  const subject = `Payment reminder: Invoice ${invoice.number}`;
  const html = `<p>Hello,</p><p>This is a friendly reminder that invoice <b>${invoice.number}</b> for <b>$${balance.toFixed(2)}</b> was due on ${invoice.dueDate?.toDateString() || 'the agreed date'} and is still unpaid.</p><p>Please arrange payment at your earliest convenience.</p>`;
  return sendAndRecord({
    to,
    subject,
    html,
    templateKey: 'payment_reminder',
    companyId: invoice.companyId,
    contactId: invoice.contactId,
    relatedType: 'INVOICE',
    relatedId: invoice.id,
  });
}

export async function sendOrderConfirmation(salesOrderId: string) {
  const order = await prisma.salesOrder.findUniqueOrThrow({
    where: { id: salesOrderId },
    include: { company: { include: { emails: true } }, contact: true, items: true },
  });
  const to = recipientEmail(order);
  if (!to) return { sent: false, reason: 'No recipient email on file' };

  const itemsHtml = order.items
    .map((i) => `<li>${i.description} — qty ${i.quantity} × $${Number(i.unitPrice).toFixed(2)}</li>`)
    .join('');

  const subject = `Order confirmation ${order.number}`;
  const html = `<p>Hello,</p><p>Your order <b>${order.number}</b> has been confirmed.</p><ul>${itemsHtml}</ul><p>Total: $${Number(order.total).toFixed(2)}</p>`;
  return sendAndRecord({
    to,
    subject,
    html,
    templateKey: 'order_confirmation',
    companyId: order.companyId,
    contactId: order.contactId,
    relatedType: 'SALES_ORDER',
    relatedId: order.id,
  });
}
