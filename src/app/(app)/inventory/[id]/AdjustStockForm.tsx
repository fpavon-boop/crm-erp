'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

interface Variant { id: string; name: string; sku: string }
interface Warehouse { id: string; name: string }

export default function AdjustStockForm({ variants, warehouses }: { variants: Variant[]; warehouses: Warehouse[] }) {
  const router = useRouter();
  const [productVariantId, setVariantId] = useState(variants[0]?.id || '');
  const [warehouseId, setWarehouseId] = useState(warehouses[0]?.id || '');
  const [type, setType] = useState<'IN' | 'OUT' | 'ADJUSTMENT'>('IN');
  const [quantity, setQuantity] = useState('1');
  const [reason, setReason] = useState('');
  const [saving, setSaving] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!productVariantId || !warehouseId) return;
    setSaving(true);
    await fetch('/api/inventory/adjust', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ productVariantId, warehouseId, type, quantity: Number(quantity), reason: reason || undefined }),
    });
    setSaving(false);
    setReason('');
    router.refresh();
  }

  return (
    <form onSubmit={submit} className="grid grid-cols-2 md:grid-cols-5 gap-2 items-end">
      <div>
        <label className="label">Variant</label>
        <select className="input" value={productVariantId} onChange={(e) => setVariantId(e.target.value)}>
          {variants.map((v) => <option key={v.id} value={v.id}>{v.name} ({v.sku})</option>)}
        </select>
      </div>
      <div>
        <label className="label">Warehouse</label>
        <select className="input" value={warehouseId} onChange={(e) => setWarehouseId(e.target.value)}>
          {warehouses.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
        </select>
      </div>
      <div>
        <label className="label">Type</label>
        <select className="input" value={type} onChange={(e) => setType(e.target.value as never)}>
          <option value="IN">Stock in</option>
          <option value="OUT">Stock out</option>
          <option value="ADJUSTMENT">Adjustment</option>
        </select>
      </div>
      <div>
        <label className="label">Quantity</label>
        <input type="number" min={1} className="input" value={quantity} onChange={(e) => setQuantity(e.target.value)} />
      </div>
      <div className="flex gap-2">
        <input className="input" placeholder="Reason (optional)" value={reason} onChange={(e) => setReason(e.target.value)} />
        <button type="submit" disabled={saving} className="btn-primary shrink-0">{saving ? '...' : 'Apply'}</button>
      </div>
    </form>
  );
}
