'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import CompanyContactPicker from '@/components/CompanyContactPicker';
import LineItemsEditor, { LineItem, EMPTY_LINE_ITEM } from '@/components/LineItemsEditor';
import { computeTotals } from '@/lib/totals';
import { money } from '@/lib/format';

interface Initial {
  id?: string;
  companyId?: string;
  contactId?: string;
  status?: string;
  notes?: string;
  items?: LineItem[];
}

export default function OrderForm({ initial }: { initial?: Initial }) {
  const router = useRouter();
  const [companyId, setCompanyId] = useState(initial?.companyId || '');
  const [contactId, setContactId] = useState(initial?.contactId || '');
  const [status, setStatus] = useState(initial?.status || 'DRAFT');
  const [notes, setNotes] = useState(initial?.notes || '');
  const [items, setItems] = useState<LineItem[]>(initial?.items?.length ? initial.items : [{ ...EMPTY_LINE_ITEM }]);
  const [saving, setSaving] = useState(false);

  const totals = computeTotals(items);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    const payload = { companyId: companyId || null, contactId: contactId || null, status, notes: notes || null, items };
    const res = await fetch(initial?.id ? `/api/sales-orders/${initial.id}` : '/api/sales-orders', {
      method: initial?.id ? 'PUT' : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    setSaving(false);
    if (res.ok) {
      const data = await res.json();
      router.push(`/sales/orders/${data.order.id}`);
      router.refresh();
    }
  }

  return (
    <form onSubmit={submit} className="space-y-5">
      <div className="card p-6 space-y-4">
        <CompanyContactPicker companyId={companyId} contactId={contactId} onCompanyChange={setCompanyId} onContactChange={setContactId} companyType="CUSTOMER" />
        <div>
          <label className="label">Status</label>
          <select className="input max-w-xs" value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="DRAFT">Draft</option>
            <option value="CONFIRMED">Confirmed</option>
            <option value="SHIPPED">Shipped</option>
            <option value="DELIVERED">Delivered</option>
            <option value="CANCELLED">Cancelled</option>
          </select>
        </div>
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
        <button type="submit" disabled={saving} className="btn-primary">{saving ? 'Saving...' : 'Save order'}</button>
        <button type="button" className="btn-secondary" onClick={() => router.back()}>Cancel</button>
      </div>
    </form>
  );
}
