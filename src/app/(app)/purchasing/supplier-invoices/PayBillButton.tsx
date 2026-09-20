'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { PAYMENT_METHODS } from '@/lib/finance';

export default function PayBillButton({ id, open }: { id: string; open: number }) {
  const router = useRouter();
  const [show, setShow] = useState(false);
  const [amount, setAmount] = useState(open.toFixed(2));
  const [method, setMethod] = useState<string>(PAYMENT_METHODS[0]);
  const [reference, setReference] = useState('');
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (open <= 0) return <span className="text-xs text-slate-400">Paid</span>;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    const res = await fetch(`/api/supplier-invoices/${id}/payments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ amount: Number(amount), method, reference: reference || null, paidAt: date }),
    });
    setSaving(false);
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      setError(typeof data.error === 'string' ? data.error : 'Could not record the payment.');
      return;
    }
    setShow(false);
    router.refresh();
  }

  return (
    <div>
      <button className="text-blue-600 hover:text-blue-800 text-xs" onClick={() => setShow((s) => !s)}>
        {show ? 'Cancel' : 'Record payment'}
      </button>
      {show && (
        <form onSubmit={submit} className="mt-2 space-y-2 min-w-[220px]">
          {error && <p className="text-xs text-red-600">{error}</p>}
          <input type="number" step="0.01" min="0.01" max={open} required className="input !py-1 !text-xs" value={amount} onChange={(e) => setAmount(e.target.value)} />
          <input type="date" required className="input !py-1 !text-xs" value={date} onChange={(e) => setDate(e.target.value)} />
          <select className="input !py-1 !text-xs" value={method} onChange={(e) => setMethod(e.target.value)}>
            {PAYMENT_METHODS.map((m) => <option key={m} value={m}>{m}</option>)}
          </select>
          <input className="input !py-1 !text-xs" placeholder="Check no. / reference" value={reference} onChange={(e) => setReference(e.target.value)} />
          <button type="submit" disabled={saving} className="btn-primary !py-1 !text-xs">{saving ? 'Saving...' : 'Save payment'}</button>
        </form>
      )}
    </div>
  );
}
