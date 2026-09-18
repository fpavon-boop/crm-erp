'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';

interface Supplier { id: string; name: string }
interface PO { id: string; number: string }

export default function SupplierInvoiceForm() {
  const router = useRouter();
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [purchaseOrders, setPurchaseOrders] = useState<PO[]>([]);
  const [number, setNumber] = useState('');
  const [supplierId, setSupplierId] = useState('');
  const [purchaseOrderId, setPurchaseOrderId] = useState('');
  const [amount, setAmount] = useState('0');
  const [dueDate, setDueDate] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    fetch('/api/companies?type=SUPPLIER').then((r) => r.json()).then((d) => setSuppliers(d.companies || []));
    fetch('/api/purchase-orders').then((r) => r.json()).then((d) => setPurchaseOrders(d.orders || []));
  }, []);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    await fetch('/api/supplier-invoices', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        number,
        supplierId: supplierId || null,
        purchaseOrderId: purchaseOrderId || null,
        amount: Number(amount),
        dueDate: dueDate || null,
      }),
    });
    setSaving(false);
    router.push('/purchasing/supplier-invoices');
    router.refresh();
  }

  return (
    <form onSubmit={submit} className="card p-6 space-y-4 max-w-xl">
      <div><label className="label">Invoice number *</label><input className="input" required value={number} onChange={(e) => setNumber(e.target.value)} /></div>
      <div>
        <label className="label">Supplier</label>
        <select className="input" value={supplierId} onChange={(e) => setSupplierId(e.target.value)}>
          <option value="">— None —</option>
          {suppliers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
      </div>
      <div>
        <label className="label">Purchase order</label>
        <select className="input" value={purchaseOrderId} onChange={(e) => setPurchaseOrderId(e.target.value)}>
          <option value="">— None —</option>
          {purchaseOrders.map((p) => <option key={p.id} value={p.id}>{p.number}</option>)}
        </select>
      </div>
      <div className="grid grid-cols-2 gap-4">
        <div><label className="label">Amount *</label><input type="number" step="0.01" required className="input" value={amount} onChange={(e) => setAmount(e.target.value)} /></div>
        <div><label className="label">Due date</label><input type="date" className="input" value={dueDate} onChange={(e) => setDueDate(e.target.value)} /></div>
      </div>
      <div className="flex gap-2">
        <button type="submit" disabled={saving} className="btn-primary">{saving ? 'Saving...' : 'Save invoice'}</button>
        <button type="button" className="btn-secondary" onClick={() => router.back()}>Cancel</button>
      </div>
    </form>
  );
}
