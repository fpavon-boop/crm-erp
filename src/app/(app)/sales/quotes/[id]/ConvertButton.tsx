'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

export default function ConvertButton({ quoteId }: { quoteId: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  async function convert() {
    setBusy(true);
    const res = await fetch(`/api/quotes/${quoteId}/convert`, { method: 'POST' });
    setBusy(false);
    if (res.ok) {
      const data = await res.json();
      router.push(`/sales/orders/${data.order.id}`);
    }
  }

  return (
    <button className="btn-primary" disabled={busy} onClick={convert}>
      {busy ? 'Converting...' : 'Convert to Sales Order'}
    </button>
  );
}
