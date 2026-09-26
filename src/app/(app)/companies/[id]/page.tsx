import Link from 'next/link';
import { notFound } from 'next/navigation';
import type { Role } from '@prisma/client';
import { requireModule } from '@/lib/session';
import { getCustomer360, CompanyNotFoundError } from '@/lib/customer-360';
import PageHeader from '@/components/PageHeader';
import Badge from '@/components/Badge';
import { money, formatDate, formatDateTime } from '@/lib/format';
import { AddNoteForm, UploadDocumentForm, DeleteCompanyButton } from './CompanyDetailClient';
import SendCommunicationForm, { type SendCommunicationTemplateOption } from '@/components/SendCommunicationForm';
import AiSummaryCard from '@/components/ai/AiSummaryCard';
import { TEMPLATE_DEFINITIONS, TEMPLATE_KEYS, renderAllTemplates } from '@/lib/communications/templates';
import { Pencil, Download } from 'lucide-react';

/**
 * The Customer 360 view for one company. All data comes from
 * getCustomer360() (src/lib/customer-360.ts), which already restricts
 * which sections are fetched based on the viewer's role — this page only
 * decides how to *render* what it was given. See docs/CUSTOMER_360.md.
 */
export default async function CompanyDetailPage({ params }: { params: { id: string } }) {
  const session = await requireModule('companies');
  const role = session.user.role as Role;

  let data;
  try {
    data = await getCustomer360(params.id, role);
  } catch (err) {
    if (err instanceof CompanyNotFoundError) notFound();
    throw err;
  }
  const { company, sections, sales, invoicing, purchasing, tasks, whatsapp, inbox, activity } = data;

  const rendered = renderAllTemplates({ recipientName: company.name });
  const templateOptions: SendCommunicationTemplateOption[] = TEMPLATE_KEYS.map((key) => {
    const def = TEMPLATE_DEFINITIONS[key];
    const channels = def.channels.filter((c) => (c === 'email' ? sections.inbox : sections.whatsapp));
    return channels.length > 0
      ? { key, label: def.label, channels, subject: rendered[key].subject, body: rendered[key].body }
      : null;
  }).filter((t): t is SendCommunicationTemplateOption => t !== null);
  const defaultEmail = company.contacts[0]?.email || company.emails[0]?.address || null;
  const defaultPhone = company.contacts[0]?.phone || company.contacts[0]?.mobile || company.phones[0]?.number || null;

  return (
    <div>
      <PageHeader
        title={company.name}
        subtitle={`${company.type} · ${company.contacts.length} contacts`}
        actions={
          <>
            <Link href={`/companies/${company.id}/edit`} className="btn-secondary">
              <Pencil size={16} /> Edit
            </Link>
            <DeleteCompanyButton companyId={company.id} />
          </>
        }
      />

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-1 space-y-6">
          <div className="card p-5">
            <h2 className="font-semibold text-slate-800 mb-3">Profile</h2>
            <dl className="text-sm space-y-2">
              <Row label="Type"><Badge label={company.type} /></Row>
              <Row label="Status">
                <Badge label={activity.status} />
              </Row>
              <Row label="Last activity">{formatDate(activity.lastActivityAt)}</Row>
              <Row label="Tax ID">{company.taxId || '—'}</Row>
              <Row label="Industry">{company.industry || '—'}</Row>
              <Row label="Website">{company.website || '—'}</Row>
              <Row label="Owner">{company.owner?.name || 'Unassigned'}</Row>
            </dl>
          </div>

          <AiSummaryCard title="AI Customer Summary" endpoint="/api/ai/customer-summary" payload={{ companyId: company.id }} />
          <AiSummaryCard title="AI Follow-Up Suggestions" endpoint="/api/ai/follow-up-suggestions" payload={{ companyId: company.id }} />
          {sections.invoicing && (
            <AiSummaryCard title="AI Invoice / Account Summary" endpoint="/api/ai/invoice-summary" payload={{ companyId: company.id }} />
          )}

          <div className="card p-5">
            <h2 className="font-semibold text-slate-800 mb-3">Address</h2>
            <p className="text-sm text-slate-600">
              {company.addressLine1 || '—'}
              {company.addressLine2 ? <><br />{company.addressLine2}</> : null}
              <br />
              {[company.city, company.state, company.postalCode].filter(Boolean).join(', ')}
              <br />
              {company.country}
            </p>
          </div>

          <div className="card p-5">
            <h2 className="font-semibold text-slate-800 mb-3">Contact details</h2>
            <div className="text-sm space-y-1">
              {company.phones.map((p) => (
                <div key={p.id}>📞 {p.number} <span className="text-slate-400">({p.label})</span></div>
              ))}
              {company.emails.map((e) => (
                <div key={e.id}>✉️ {e.address} <span className="text-slate-400">({e.label})</span></div>
              ))}
              {company.phones.length === 0 && company.emails.length === 0 && (
                <p className="text-slate-400">No contact details on file.</p>
              )}
            </div>
          </div>

          {invoicing ? (
            <div className="card p-5">
              <h2 className="font-semibold text-slate-800 mb-1">Financial summary</h2>
              <dl className="text-sm space-y-2 mt-3">
                <Row label="Total sales">{money(invoicing.financialSummary.totalSales)}</Row>
                <Row label="Total paid">{money(invoicing.financialSummary.totalPaid)}</Row>
                <Row label="Outstanding balance">
                  <span className={invoicing.financialSummary.totalOutstanding > 0 ? 'text-red-600 font-semibold' : 'text-green-600 font-semibold'}>
                    {money(invoicing.financialSummary.totalOutstanding)}
                  </span>
                </Row>
                <Row label="Invoices">{invoicing.financialSummary.invoiceCount}</Row>
              </dl>
              <p className="text-xs text-slate-500 mt-2">
                Sales/paid/outstanding are computed from each invoice's own recorded total and amount paid — never re-derived from line items.
              </p>
            </div>
          ) : (
            <SectionUnavailableCard title="Financial summary" />
          )}

          <div className="card p-5">
            <h2 className="font-semibold text-slate-800 mb-3">Contacts ({company.contacts.length})</h2>
            <ul className="text-sm space-y-1">
              {company.contacts.map((c) => (
                <li key={c.id}>
                  <Link className="text-brand-700 hover:underline" href={`/contacts/${c.id}`}>
                    {c.firstName} {c.lastName}
                  </Link>
                  {c.position && <span className="text-slate-400"> — {c.position}</span>}
                </li>
              ))}
              {company.contacts.length === 0 && <p className="text-slate-400">No contacts yet.</p>}
            </ul>
          </div>
        </div>

        <div className="lg:col-span-2 space-y-6">
          <div className="card p-5">
            <h2 className="font-semibold text-slate-800 mb-3">Notes</h2>
            <AddNoteForm companyId={company.id} />
            <ul className="text-sm space-y-3 max-h-64 overflow-y-auto">
              {company.notesList.map((n) => (
                <li key={n.id} className="border-b border-slate-100 pb-2">
                  <p>{n.body}</p>
                  <p className="text-xs text-slate-400">{n.author.name} · {formatDateTime(n.createdAt)}</p>
                </li>
              ))}
              {company.notesList.length === 0 && <p className="text-slate-400">No notes yet.</p>}
            </ul>
          </div>

          <div className="card p-5">
            <h2 className="font-semibold text-slate-800 mb-3">Documents</h2>
            <UploadDocumentForm companyId={company.id} />
            <ul className="text-sm divide-y divide-slate-100">
              {company.documents.map((d) => (
                <li key={d.id} className="py-2 flex items-center justify-between">
                  <span>{d.filename}</span>
                  <a href={`/api/documents/${d.id}/download`} className="text-brand-700 hover:underline flex items-center gap-1">
                    <Download size={14} /> Download
                  </a>
                </li>
              ))}
              {company.documents.length === 0 && <p className="text-slate-400">No documents uploaded.</p>}
            </ul>
          </div>

          <div className="card p-5">
            <h2 className="font-semibold text-slate-800 mb-3">Communication history</h2>
            {templateOptions.length > 0 && (
              <SendCommunicationForm
                templates={templateOptions}
                defaultEmail={defaultEmail}
                defaultPhone={defaultPhone}
                companyId={company.id}
                contactId={company.contacts[0]?.id}
              />
            )}
            <ul className="text-sm space-y-2 max-h-72 overflow-y-auto">
              {company.communicationLogs.map((log) => (
                <li key={log.id} className="border-b border-slate-100 pb-2">
                  <div className="flex items-center gap-2 flex-wrap">
                    <Badge label={log.type} />
                    <span className="text-xs text-slate-400">{log.direction} · {formatDateTime(log.occurredAt)}</span>
                    {log.status && <Badge label={log.status} />}
                    {log.templateKey && <span className="text-xs text-slate-400">via {log.templateKey.replace(/_/g, ' ')}</span>}
                    {log.relatedType && log.relatedId && (
                      <span className="text-xs text-slate-400">re: {log.relatedType.replace(/_/g, ' ').toLowerCase()}</span>
                    )}
                  </div>
                  {log.subject && <p className="font-medium">{log.subject}</p>}
                  {log.body && <p className="text-slate-600 line-clamp-2">{log.body}</p>}
                  {(log.recipient || log.user?.name || log.direction === 'OUTBOUND') && (
                    <p className="text-xs text-slate-400">
                      {log.recipient && <>to {log.recipient} · </>}
                      {log.user?.name ? `by ${log.user.name}` : log.direction === 'OUTBOUND' ? 'automated' : null}
                    </p>
                  )}
                </li>
              ))}
              {company.communicationLogs.length === 0 && <p className="text-slate-400">No communication history yet.</p>}
            </ul>
          </div>

          {(inbox || whatsapp) && (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              {inbox ? (
                <div className="card p-5">
                  <h2 className="font-semibold text-slate-800 mb-3">Recent emails</h2>
                  <ul className="text-sm divide-y divide-slate-100 max-h-64 overflow-y-auto">
                    {inbox.messages.map((m) => (
                      <li key={m.id} className="py-2">
                        <p className="font-medium truncate">{m.subject || '(no subject)'}</p>
                        <p className="text-xs text-slate-400">{formatDateTime(m.receivedAt)}</p>
                      </li>
                    ))}
                    {inbox.messages.length === 0 && <p className="text-slate-400">No emails yet.</p>}
                  </ul>
                </div>
              ) : (
                <SectionUnavailableCard title="Recent emails" />
              )}
              {whatsapp ? (
                <div className="card p-5">
                  <h2 className="font-semibold text-slate-800 mb-3">WhatsApp messages</h2>
                  <ul className="text-sm divide-y divide-slate-100 max-h-64 overflow-y-auto">
                    {whatsapp.messages.map((m) => (
                      <li key={m.id} className="py-2">
                        <p className="text-slate-700 line-clamp-2">{m.body || `(${m.messageType})`}</p>
                        <p className="text-xs text-slate-400">{m.direction} · {formatDateTime(m.timestamp)}</p>
                      </li>
                    ))}
                    {whatsapp.messages.length === 0 && <p className="text-slate-400">No WhatsApp messages yet.</p>}
                  </ul>
                </div>
              ) : (
                <SectionUnavailableCard title="WhatsApp messages" />
              )}
            </div>
          )}

          {sales ? (
            <div className="card p-5">
              <h2 className="font-semibold text-slate-800 mb-3">Products purchased</h2>
              {sales.topProducts.length === 0 ? (
                <p className="text-slate-400 text-sm">No purchase history yet.</p>
              ) : (
                <ul className="text-sm divide-y divide-slate-100">
                  {sales.topProducts.map((p) => (
                    <li key={p.productId} className="py-2 flex items-center justify-between">
                      <div>
                        <Link href={`/inventory/${p.productId}`} className="text-brand-700 hover:underline">{p.name}</Link>
                        <span className="text-slate-400"> · {p.sku}</span>
                      </div>
                      <div className="text-right">
                        <div>{money(p.totalSpent)}</div>
                        <div className="text-xs text-slate-400">{p.totalQuantity} units</div>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ) : (
            <SectionUnavailableCard title="Products purchased" />
          )}

          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            {invoicing ? (
              <div className="card p-5">
                <h2 className="font-semibold text-slate-800 mb-3">Invoices</h2>
                <RecordList
                  items={invoicing.invoices.map((i) => ({
                    id: i.id,
                    href: `/invoicing/${i.id}`,
                    label: i.number,
                    status: i.status,
                    amount: money(i.total),
                    date: formatDate(i.issueDate),
                  }))}
                  emptyLabel="No invoices yet."
                />
              </div>
            ) : (
              <SectionUnavailableCard title="Invoices" />
            )}
            {sales ? (
              <div className="card p-5">
                <h2 className="font-semibold text-slate-800 mb-3">Sales orders</h2>
                <RecordList
                  items={sales.salesOrders.map((o) => ({
                    id: o.id,
                    href: `/sales/orders/${o.id}`,
                    label: o.number,
                    status: o.status,
                    amount: money(o.total),
                    date: formatDate(o.createdAt),
                  }))}
                  emptyLabel="No orders yet."
                />
              </div>
            ) : (
              <SectionUnavailableCard title="Sales orders" />
            )}
            {sales ? (
              <div className="card p-5">
                <h2 className="font-semibold text-slate-800 mb-3">Quotes</h2>
                <RecordList
                  items={sales.quotes.map((q) => ({
                    id: q.id,
                    href: `/sales/quotes/${q.id}`,
                    label: q.number,
                    status: q.status,
                    amount: money(q.total),
                    date: formatDate(q.createdAt),
                  }))}
                  emptyLabel="No quotes yet."
                />
              </div>
            ) : (
              <SectionUnavailableCard title="Quotes" />
            )}
            {purchasing ? (
              <div className="card p-5">
                <h2 className="font-semibold text-slate-800 mb-3">Purchase orders</h2>
                <RecordList
                  items={purchasing.purchaseOrders.map((p) => ({
                    id: p.id,
                    href: `/purchasing/orders/${p.id}`,
                    label: p.number,
                    status: p.status,
                    amount: money(p.total),
                    date: formatDate(p.createdAt),
                  }))}
                  emptyLabel="No purchase orders yet."
                />
              </div>
            ) : (
              <SectionUnavailableCard title="Purchase orders" />
            )}
          </div>

          {sales ? (
            <div className="card p-5">
              <h2 className="font-semibold text-slate-800 mb-3">Opportunities</h2>
              <RecordList
                items={sales.opportunities.map((o) => ({
                  id: o.id,
                  href: `/sales/pipeline`,
                  label: o.title,
                  status: o.stage,
                  amount: money(o.value),
                  date: formatDate(o.createdAt),
                }))}
                emptyLabel="No opportunities yet."
              />
            </div>
          ) : (
            <SectionUnavailableCard title="Opportunities" />
          )}

          {invoicing ? (
            <div className="card p-5">
              <h2 className="font-semibold text-slate-800 mb-3">Payments</h2>
              {invoicing.payments.length === 0 ? (
                <p className="text-slate-400 text-sm">No payments recorded yet.</p>
              ) : (
                <ul className="text-sm divide-y divide-slate-100">
                  {invoicing.payments.map((p) => (
                    <li key={p.id} className="py-2 flex items-center justify-between">
                      <div>
                        <span className="text-slate-700">{p.invoiceNumber}</span>
                        <span className="text-slate-400"> · {p.method}</span>
                      </div>
                      <div className="text-right">
                        <div>{money(p.amount)}</div>
                        <div className="text-xs text-slate-400">{formatDate(p.paidAt)}</div>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ) : (
            <SectionUnavailableCard title="Payments" />
          )}

          {tasks ? (
            <div className="card p-5">
              <h2 className="font-semibold text-slate-800 mb-3">Tasks</h2>
              {tasks.tasks.length === 0 ? (
                <p className="text-slate-400 text-sm">No tasks linked to this company yet.</p>
              ) : (
                <ul className="text-sm divide-y divide-slate-100">
                  {tasks.tasks.map((t) => (
                    <li key={t.id} className="py-2 flex items-center justify-between">
                      <div>
                        <Link href="/tasks" className="text-brand-700 hover:underline">{t.title}</Link>
                        {t.dueDate && <span className="text-xs text-slate-400"> · due {formatDate(t.dueDate)}</span>}
                      </div>
                      <div className="flex items-center gap-2">
                        <Badge label={t.priority} />
                        <Badge label={t.status} />
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ) : (
            <SectionUnavailableCard title="Tasks" />
          )}
        </div>
      </div>
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex justify-between gap-4">
      <dt className="text-slate-500">{label}</dt>
      <dd className="text-slate-800 text-right">{children}</dd>
    </div>
  );
}

/** Shown in place of a section the viewer's role isn't permitted to see
 * (see getCustomer360Sections in src/lib/customer-360.ts), so the layout
 * stays predictable rather than sections silently vanishing. */
function SectionUnavailableCard({ title }: { title: string }) {
  return (
    <div className="card p-5">
      <h2 className="font-semibold text-slate-800 mb-1">{title}</h2>
      <p className="text-sm text-slate-400">Your role doesn&apos;t have access to this information.</p>
    </div>
  );
}

function RecordList({
  items,
  emptyLabel,
}: {
  items: { id: string; href: string; label: string; status: string; amount: string; date: string }[];
  emptyLabel: string;
}) {
  if (items.length === 0) return <p className="text-slate-400 text-sm">{emptyLabel}</p>;
  return (
    <ul className="text-sm divide-y divide-slate-100">
      {items.map((item) => (
        <li key={item.id} className="py-2 flex items-center justify-between">
          <Link href={item.href} className="text-brand-700 hover:underline">
            {item.label}
          </Link>
          <div className="flex items-center gap-2">
            <Badge label={item.status} />
            <span className="text-slate-600">{item.amount}</span>
          </div>
        </li>
      ))}
    </ul>
  );
}
