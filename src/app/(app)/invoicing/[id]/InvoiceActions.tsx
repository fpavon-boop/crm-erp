'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

export function SendInvoiceButton({ invoiceId }: { invoiceId: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function send() {
    setBusy(true);
    setMessage(null);
    const res = await fetch(`/api/invoices/${invoiceId}/send`, { method: 'POST' });
    const data = await res.json();
    setBusy(false);
    setMessage(data.sent ? 'Email sent.' : `Not sent: ${data.reason}`);
    router.refresh();
  }

  return (
    <div className="flex items-center gap-2">
      <button className="btn-secondary" disabled={busy} onClick={send}>{busy ? 'Sending...' : 'Send by email'}</button>
      {message && <span className="text-xs text-slate-500">{message}</span>}
    </div>
  );
}

export function RecordPaymentForm({ invoiceId, balance }: { invoiceId: string; balance: number }) {
  const router = useRouter();
  const [amount, setAmount] = useState(balance > 0 ? String(balance) : '0');
  const [method, setMethod] = useState('bank_transfer');
  const [reference, setReference] = useState('');
  const [saving, setSaving] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    await fetch(`/api/invoices/${invoiceId}/payments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ amount: Number(amount), method, reference: reference || undefined }),
    });
    setSaving(false);
    router.refresh();
  }

  if (balance <= 0) return null;

  return (
    <form onSubmit={submit} className="flex flex-wrap gap-2 items-end">
      <div>
        <label className="label">Amount</label>
        <input type="number" step="0.01" className="input w-32" value={amount} onChange={(e) => setAmount(e.target.value)} />
      </div>
      <div>
        <label className="label">Method</label>
        <select className="input" value={method} onChange={(e) => setMethod(e.target.value)}>
          <option value="bank_transfer">Bank transfer</option>
          <option value="card">Card</option>
          <option value="cash">Cash</option>
          <option value="check">Check</option>
          <option value="other">Other</option>
        </select>
      </div>
      <div>
        <label className="label">Reference</label>
        <input className="input" value={reference} onChange={(e) => setReference(e.target.value)} />
      </div>
      <button type="submit" disabled={saving} className="btn-primary shrink-0">{saving ? 'Saving...' : 'Record payment'}</button>
    </form>
  );
}
