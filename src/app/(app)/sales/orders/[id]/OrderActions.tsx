'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

const NEXT_STATUS: Record<string, string[]> = {
  DRAFT: ['CONFIRMED', 'CANCELLED'],
  CONFIRMED: ['SHIPPED', 'CANCELLED'],
  SHIPPED: ['DELIVERED'],
  DELIVERED: [],
  CANCELLED: [],
};

export function StatusControls({ orderId, status }: { orderId: string; status: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const options = NEXT_STATUS[status] || [];
  if (options.length === 0) return null;

  async function changeStatus(next: string) {
    setBusy(true);
    await fetch(`/api/sales-orders/${orderId}/status`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: next }),
    });
    setBusy(false);
    router.refresh();
  }

  return (
    <div className="flex gap-2">
      {options.map((s) => (
        <button key={s} disabled={busy} className="btn-secondary" onClick={() => changeStatus(s)}>
          Mark {s.charAt(0) + s.slice(1).toLowerCase()}
        </button>
      ))}
    </div>
  );
}

export function CreateInvoiceButton({ orderId }: { orderId: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  async function create() {
    setBusy(true);
    const res = await fetch(`/api/sales-orders/${orderId}/create-invoice`, { method: 'POST' });
    setBusy(false);
    if (res.ok) {
      const data = await res.json();
      router.push(`/invoicing/${data.invoice.id}`);
    }
  }

  return (
    <button className="btn-primary" disabled={busy} onClick={create}>
      {busy ? 'Creating...' : 'Create Invoice'}
    </button>
  );
}
