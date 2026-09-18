import { prisma } from '@/lib/prisma';
import { sendSystemEmail } from '@/lib/email/smtp';
import { renderInvoicePdf } from '@/lib/pdf';

function recipientEmail(invoiceOrOrder: {
  contact?: { email: string | null } | null;
  company?: { emails?: { address: string }[] } | null;
}): string | null {
  if (invoiceOrOrder.contact?.email) return invoiceOrOrder.contact.email;
  const first = invoiceOrOrder.company?.emails?.[0]?.address;
  return first || null;
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

  return sendSystemEmail({
    to,
    subject: `${invoice.type === 'INVOICE' ? 'Invoice' : invoice.type === 'ESTIMATE' ? 'Estimate' : 'Receipt'} ${invoice.number}`,
    html: `<p>Hello,</p><p>Please find attached your ${invoice.type.toLowerCase()} <b>${invoice.number}</b> for a total of $${Number(invoice.total).toFixed(2)}.</p><p>Thank you for your business.</p>`,
    attachments: [{ filename: `${invoice.number}.pdf`, content: pdf }],
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
  return sendSystemEmail({
    to,
    subject: `Payment reminder: Invoice ${invoice.number}`,
    html: `<p>Hello,</p><p>This is a friendly reminder that invoice <b>${invoice.number}</b> for <b>$${balance.toFixed(2)}</b> was due on ${invoice.dueDate?.toDateString() || 'the agreed date'} and is still unpaid.</p><p>Please arrange payment at your earliest convenience.</p>`,
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

  return sendSystemEmail({
    to,
    subject: `Order confirmation ${order.number}`,
    html: `<p>Hello,</p><p>Your order <b>${order.number}</b> has been confirmed.</p><ul>${itemsHtml}</ul><p>Total: $${Number(order.total).toFixed(2)}</p>`,
  });
}
