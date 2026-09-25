import Link from 'next/link';
import { notFound } from 'next/navigation';
import type { Role } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { requireModule } from '@/lib/session';
import { canAccess } from '@/lib/permissions';
import PageHeader from '@/components/PageHeader';
import Badge from '@/components/Badge';
import { money, formatDate, formatDateTime, toNumber } from '@/lib/format';
import { StatusControls, CreateInvoiceButton } from './OrderActions';
import SendCommunicationForm, { type SendCommunicationTemplateOption } from '@/components/SendCommunicationForm';
import { TEMPLATE_DEFINITIONS, TEMPLATE_KEYS, renderAllTemplates } from '@/lib/communications/templates';
import { getRelatedCommunicationTimeline } from '@/lib/communications/history';
import { Pencil } from 'lucide-react';

export default async function OrderDetailPage({ params }: { params: { id: string } }) {
  const session = await requireModule('sales');
  const role = session.user.role as Role;
  const order = await prisma.salesOrder.findUnique({
    where: { id: params.id },
    include: {
      company: { include: { emails: true, phones: true } },
      contact: true,
      items: true,
      invoices: true,
      quote: true,
    },
  });
  if (!order) notFound();

  const canSendEmail = canAccess(role, 'inbox');
  const canSendWhatsApp = canAccess(role, 'whatsapp');
  const primaryInvoice = order.invoices[0];
  const rendered = renderAllTemplates({
    recipientName: order.contact ? `${order.contact.firstName} ${order.contact.lastName}` : order.company?.name || 'there',
    orderNumber: order.number,
    orderTotal: toNumber(order.total),
    invoiceNumber: primaryInvoice?.number,
    invoiceTotal: primaryInvoice ? toNumber(primaryInvoice.total) : null,
    balanceDue: primaryInvoice ? toNumber(primaryInvoice.total) - toNumber(primaryInvoice.amountPaid) : null,
    dueDate: primaryInvoice?.dueDate,
    quoteNumber: order.quote?.number,
    quoteTotal: order.quote ? toNumber(order.quote.total) : null,
  });
  const templateOptions: SendCommunicationTemplateOption[] = TEMPLATE_KEYS.map((key) => {
    const def = TEMPLATE_DEFINITIONS[key];
    const channels = def.channels.filter((c) => (c === 'email' ? canSendEmail : canSendWhatsApp));
    return channels.length > 0
      ? { key, label: def.label, channels, subject: rendered[key].subject, body: rendered[key].body }
      : null;
  }).filter((t): t is SendCommunicationTemplateOption => t !== null);
  const defaultEmail = order.contact?.email || order.company?.emails[0]?.address || null;
  const defaultPhone = order.contact?.phone || order.contact?.mobile || order.company?.phones[0]?.number || null;

  const communications = canSendEmail || canSendWhatsApp ? await getRelatedCommunicationTimeline('SALES_ORDER', order.id) : [];

  return (
    <div>
      <PageHeader
        title={order.number}
        subtitle={order.company?.name}
        actions={
          <>
            <Link href={`/sales/orders/${order.id}/edit`} className="btn-secondary"><Pencil size={16} /> Edit</Link>
            <StatusControls orderId={order.id} status={order.status} />
            {order.invoices.length === 0 && <CreateInvoiceButton orderId={order.id} />}
          </>
        }
      />

      <div className="card p-6 mb-6">
        <p className="mb-4"><Badge label={order.status} /></p>
        <table className="table-base">
          <thead><tr><th>Description</th><th>Qty</th><th>Unit price</th><th>Tax</th></tr></thead>
          <tbody>
            {order.items.map((i) => (
              <tr key={i.id}>
                <td>{i.description}</td>
                <td>{i.quantity.toString()}</td>
                <td>{money(i.unitPrice)}</td>
                <td>{i.taxRate.toString()}%</td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="mt-4 flex justify-end">
          <table className="text-sm w-64">
            <tbody>
              <tr className="font-semibold border-t border-slate-200"><td className="py-1">Total</td><td className="text-right">{money(order.total)}</td></tr>
            </tbody>
          </table>
        </div>
      </div>

      {order.invoices.length > 0 && (
        <div className="card p-5">
          <h2 className="font-semibold text-slate-800 mb-2">Invoices</h2>
          <ul className="text-sm space-y-1">
            {order.invoices.map((inv) => (
              <li key={inv.id} className="flex justify-between">
                <Link href={`/invoicing/${inv.id}`} className="text-brand-700 hover:underline">{inv.number}</Link>
                <span>{money(inv.total)} · {formatDate(inv.issueDate)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {(canSendEmail || canSendWhatsApp) && (
        <div className="card p-5 mt-6">
          <h2 className="font-semibold text-slate-800 mb-3">Communication</h2>
          {templateOptions.length > 0 && (
            <SendCommunicationForm
              templates={templateOptions}
              defaultEmail={defaultEmail}
              defaultPhone={defaultPhone}
              companyId={order.companyId}
              contactId={order.contactId}
              linkTarget={{ relatedType: 'SALES_ORDER', relatedId: order.id }}
            />
          )}
          <ul className="text-sm space-y-2 max-h-72 overflow-y-auto">
            {communications.map((log) => (
              <li key={log.id} className="border-b border-slate-100 pb-2">
                <div className="flex items-center gap-2 flex-wrap">
                  <Badge label={log.type} />
                  <span className="text-xs text-slate-400">{log.direction} · {formatDateTime(log.occurredAt)}</span>
                  {log.status && <Badge label={log.status} />}
                  {log.templateKey && <span className="text-xs text-slate-400">via {log.templateKey.replace(/_/g, ' ')}</span>}
                </div>
                {log.subject && <p className="font-medium">{log.subject}</p>}
                {log.body && <p className="text-slate-600 line-clamp-2">{log.body}</p>}
                {(log.recipient || log.user?.name) && (
                  <p className="text-xs text-slate-400">
                    {log.recipient && <>to {log.recipient} · </>}
                    {log.user?.name ? `by ${log.user.name}` : 'automated'}
                  </p>
                )}
              </li>
            ))}
            {communications.length === 0 && <p className="text-slate-400">No messages sent about this order yet.</p>}
          </ul>
        </div>
      )}
    </div>
  );
}
