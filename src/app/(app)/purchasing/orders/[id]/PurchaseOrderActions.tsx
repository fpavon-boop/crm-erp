'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import type { PurchaseOrderStatus } from '@prisma/client';

export default function PurchaseOrderActions({ purchaseOrderId, status }: { purchaseOrderId: string; status: PurchaseOrderStatus }) {
  const router = useRouter();
  const [busy, setBusy] = useState<'approve' | 'cancel' | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function run(action: 'approve' | 'cancel') {
    setBusy(action);
    setError(null);
    const res = await fetch(`/api/purchase-orders/${purchaseOrderId}/${action}`, { method: 'POST' });
    setBusy(null);
    if (!res.ok) {
      const data = await res.json().catch(() => null);
      setError(data?.error || `Could not ${action} this purchase order.`);
      return;
    }
    router.refresh();
  }

  if (status !== 'DRAFT' && status !== 'SENT') return null;

  return (
    <div className="flex items-center gap-2">
      {status === 'DRAFT' && (
        <button type="button" disabled={busy !== null} className="btn-primary" onClick={() => run('approve')}>
          {busy === 'approve' ? 'Approving...' : 'Approve & send'}
        </button>
      )}
      <button type="button" disabled={busy !== null} className="btn-secondary" onClick={() => run('cancel')}>
        {busy === 'cancel' ? 'Cancelling...' : 'Cancel order'}
      </button>
      {error && <span className="text-sm text-red-600">{error}</span>}
    </div>
  );
}
