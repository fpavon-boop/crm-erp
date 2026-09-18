'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import LineItemsEditor, { LineItem, EMPTY_LINE_ITEM } from '@/components/LineItemsEditor';

interface Supplier { id: string; name: string }

export default function PurchaseOrderForm() {
  const router = useRouter();
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [supplierId, setSupplierId] = useState('');
  const [expectedDate, setExpectedDate] = useState('');
  const [notes, setNotes] = useState('');
  const [items, setItems] = useState<LineItem[]>([{ ...EMPTY_LINE_ITEM }]);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    fetch('/api/companies?type=SUPPLIER')
      .then((r) => r.json())
      .then((d) => setSuppliers(d.companies || []));
  }, []);

  const total = items.reduce((s, i) => s + i.quantity * i.unitPrice, 0);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    const payload = {
      supplierId: supplierId || null,
      expectedDate: expectedDate || null,
      notes: notes || null,
      items: items.map((i) => ({
        productId: i.productId,
        productVariantId: i.productVariantId,
        description: i.description,
        quantity: i.quantity,
        unitCost: i.unitPrice,
      })),
    };
    const res = await fetch('/api/purchase-orders', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    setSaving(false);
    if (res.ok) {
      const data = await res.json();
      router.push(`/purchasing/orders/${data.order.id}`);
      router.refresh();
    }
  }

  return (
    <form onSubmit={submit} className="space-y-5">
      <div className="card p-6 grid grid-cols-2 gap-4">
        <div>
          <label className="label">Supplier</label>
          <select className="input" value={supplierId} onChange={(e) => setSupplierId(e.target.value)}>
            <option value="">— None —</option>
            {suppliers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </div>
        <div>
          <label className="label">Expected date</label>
          <input type="date" className="input" value={expectedDate} onChange={(e) => setExpectedDate(e.target.value)} />
        </div>
      </div>

      <div className="card p-6">
        <h2 className="font-semibold text-slate-800 mb-3">Line items</h2>
        <LineItemsEditor items={items} onChange={setItems} costLabel="Unit cost" hideTax hideDiscount />
        <p className="text-right font-semibold mt-4">Total: ${total.toFixed(2)}</p>
      </div>

      <div className="card p-6">
        <label className="label">Notes</label>
        <textarea className="input" rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} />
      </div>

      <div className="flex gap-2">
        <button type="submit" disabled={saving} className="btn-primary">{saving ? 'Saving...' : 'Create purchase order'}</button>
        <button type="button" className="btn-secondary" onClick={() => router.back()}>Cancel</button>
      </div>
    </form>
  );
}
