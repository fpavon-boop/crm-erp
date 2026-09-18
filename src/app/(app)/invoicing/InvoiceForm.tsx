'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import CompanyContactPicker from '@/components/CompanyContactPicker';
import LineItemsEditor, { LineItem, EMPTY_LINE_ITEM } from '@/components/LineItemsEditor';
import { computeTotals } from '@/lib/totals';
import { money } from '@/lib/format';

interface Initial {
  id?: string;
  type?: string;
  companyId?: string;
  contactId?: string;
  status?: string;
  dueDate?: string;
  notes?: string;
  items?: LineItem[];
}

export default function InvoiceForm({ initial }: { initial?: Initial }) {
  const router = useRouter();
  const [type, setType] = useState(initial?.type || 'INVOICE');
  const [companyId, setCompanyId] = useState(initial?.companyId || '');
  const [contactId, setContactId] = useState(initial?.contactId || '');
  const [status, setStatus] = useState(initial?.status || 'DRAFT');
  const [dueDate, setDueDate] = useState(initial?.dueDate || '');
  const [notes, setNotes] = useState(initial?.notes || '');
  const [items, setItems] = useState<LineItem[]>(initial?.items?.length ? initial.items : [{ ...EMPTY_LINE_ITEM }]);
  const [saving, setSaving] = useState(false);

  const totals = computeTotals(items);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    const payload = { type, companyId: companyId || null, contactId: contactId || null, status, dueDate: dueDate || null, notes: notes || null, items };
    const res = await fetch(initial?.id ? `/api/invoices/${initial.id}` : '/api/invoices', {
      method: initial?.id ? 'PUT' : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    setSaving(false);
    if (res.ok) {
      const data = await res.json();
      router.push(`/invoicing/${data.invoice.id}`);
      router.refresh();
    }
  }

  return (
    <form onSubmit={submit} className="space-y-5">
      <div className="card p-6 space-y-4">
        <div className="grid grid-cols-3 gap-4">
          <div>
            <label className="label">Document type</label>
            <select className="input" value={type} onChange={(e) => setType(e.target.value)}>
              <option value="INVOICE">Invoice</option>
              <option value="ESTIMATE">Estimate</option>
              <option value="RECEIPT">Receipt</option>
            </select>
          </div>
          <div>
            <label className="label">Status</label>
            <select className="input" value={status} onChange={(e) => setStatus(e.target.value)}>
              <option value="DRAFT">Draft</option>
              <option value="SENT">Sent</option>
              <option value="PARTIAL">Partial</option>
              <option value="PAID">Paid</option>
              <option value="OVERDUE">Overdue</option>
              <option value="CANCELLED">Cancelled</option>
            </select>
          </div>
          <div>
            <label className="label">Due date</label>
            <input type="date" className="input" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
          </div>
        </div>
        <CompanyContactPicker companyId={companyId} contactId={contactId} onCompanyChange={setCompanyId} onContactChange={setContactId} companyType="CUSTOMER" />
      </div>

      <div className="card p-6">
        <h2 className="font-semibold text-slate-800 mb-3">Line items</h2>
        <LineItemsEditor items={items} onChange={setItems} />
        <div className="mt-4 flex justify-end">
          <table className="text-sm w-64">
            <tbody>
              <tr><td className="py-1 text-slate-500">Subtotal</td><td className="text-right">{money(totals.subtotal)}</td></tr>
              <tr><td className="py-1 text-slate-500">Tax</td><td className="text-right">{money(totals.taxTotal)}</td></tr>
              <tr><td className="py-1 text-slate-500">Discount</td><td className="text-right">-{money(totals.discountTotal)}</td></tr>
              <tr className="font-semibold border-t border-slate-200"><td className="py-1">Total</td><td className="text-right">{money(totals.total)}</td></tr>
            </tbody>
          </table>
        </div>
      </div>

      <div className="card p-6">
        <label className="label">Notes</label>
        <textarea className="input" rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} />
      </div>

      <div className="flex gap-2">
        <button type="submit" disabled={saving} className="btn-primary">{saving ? 'Saving...' : 'Save document'}</button>
        <button type="button" className="btn-secondary" onClick={() => router.back()}>Cancel</button>
      </div>
    </form>
  );
}
