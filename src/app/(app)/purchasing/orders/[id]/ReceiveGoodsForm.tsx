'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';

interface Item {
  id: string;
  description: string;
  quantity: number;
  quantityReceived: number;
  productId: string | null;
  productVariantId: string | null;
}
interface Warehouse { id: string; name: string }

export default function ReceiveGoodsForm({ purchaseOrderId, items }: { purchaseOrderId: string; items: Item[] }) {
  const router = useRouter();
  const [warehouses, setWarehouses] = useState<Warehouse[]>([]);
  const [warehouseId, setWarehouseId] = useState('');
  const [quantities, setQuantities] = useState<Record<string, number>>(
    Object.fromEntries(items.map((i) => [i.id, Math.max(i.quantity - i.quantityReceived, 0)]))
  );
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    fetch('/api/warehouses')
      .then((r) => r.json())
      .then((d) => {
        setWarehouses(d.warehouses || []);
        if (d.warehouses?.[0]) setWarehouseId(d.warehouses[0].id);
      });
  }, []);

  const pending = items.filter((i) => i.quantity - i.quantityReceived > 0);
  if (pending.length === 0) return <p className="text-sm text-slate-400">All items have been received.</p>;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!warehouseId) return;
    setSaving(true);
    const payload = {
      warehouseId,
      items: pending
        .filter((i) => quantities[i.id] > 0)
        .map((i) => ({
          purchaseOrderItemId: i.id,
          productId: i.productId,
          productVariantId: i.productVariantId,
          quantity: quantities[i.id],
        })),
    };
    await fetch(`/api/purchase-orders/${purchaseOrderId}/receive`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    setSaving(false);
    router.refresh();
  }

  return (
    <form onSubmit={submit} className="space-y-3">
      <div>
        <label className="label">Warehouse</label>
        <select className="input max-w-xs" value={warehouseId} onChange={(e) => setWarehouseId(e.target.value)}>
          {warehouses.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
        </select>
      </div>
      <table className="table-base">
        <thead><tr><th>Item</th><th>Ordered</th><th>Received</th><th>Receive now</th></tr></thead>
        <tbody>
          {pending.map((i) => (
            <tr key={i.id}>
              <td>{i.description}</td>
              <td>{i.quantity}</td>
              <td>{i.quantityReceived}</td>
              <td>
                <input
                  type="number"
                  min={0}
                  max={i.quantity - i.quantityReceived}
                  className="input w-24"
                  value={quantities[i.id]}
                  onChange={(e) => setQuantities((q) => ({ ...q, [i.id]: Number(e.target.value) }))}
                />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <button type="submit" disabled={saving || !warehouseId} className="btn-primary">{saving ? 'Recording...' : 'Record receipt'}</button>
    </form>
  );
}
