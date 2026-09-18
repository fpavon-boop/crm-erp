'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

interface Values {
  id?: string;
  sku: string;
  name: string;
  description: string;
  category: string;
  unit: string;
  price: string;
  cost: string;
  taxRate: string;
  trackInventory: boolean;
  reorderPoint: string;
}

const EMPTY: Values = {
  sku: '', name: '', description: '', category: '', unit: 'unit', price: '0', cost: '0', taxRate: '0', trackInventory: true, reorderPoint: '0',
};

export default function ProductForm({ initial }: { initial?: Partial<Values> }) {
  const router = useRouter();
  const [values, setValues] = useState<Values>({ ...EMPTY, ...initial });
  const [saving, setSaving] = useState(false);

  function set<K extends keyof Values>(key: K, value: Values[K]) {
    setValues((v) => ({ ...v, [key]: value }));
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    const payload = {
      sku: values.sku,
      name: values.name,
      description: values.description || null,
      category: values.category || null,
      unit: values.unit,
      price: Number(values.price),
      cost: Number(values.cost),
      taxRate: Number(values.taxRate),
      trackInventory: values.trackInventory,
      reorderPoint: Number(values.reorderPoint),
    };
    const res = await fetch(values.id ? `/api/products/${values.id}` : '/api/products', {
      method: values.id ? 'PUT' : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    setSaving(false);
    if (res.ok) {
      const data = await res.json();
      router.push(`/inventory/${data.product.id}`);
      router.refresh();
    }
  }

  return (
    <form onSubmit={submit} className="card p-6 space-y-5 max-w-2xl">
      <div className="grid grid-cols-2 gap-4">
        <div><label className="label">SKU *</label><input className="input" required value={values.sku} onChange={(e) => set('sku', e.target.value)} /></div>
        <div><label className="label">Name *</label><input className="input" required value={values.name} onChange={(e) => set('name', e.target.value)} /></div>
      </div>
      <div><label className="label">Description</label><textarea className="input" rows={2} value={values.description} onChange={(e) => set('description', e.target.value)} /></div>
      <div className="grid grid-cols-2 gap-4">
        <div><label className="label">Category</label><input className="input" value={values.category} onChange={(e) => set('category', e.target.value)} /></div>
        <div><label className="label">Unit</label><input className="input" value={values.unit} onChange={(e) => set('unit', e.target.value)} /></div>
      </div>
      <div className="grid grid-cols-3 gap-4">
        <div><label className="label">Price</label><input type="number" step="0.01" className="input" value={values.price} onChange={(e) => set('price', e.target.value)} /></div>
        <div><label className="label">Cost</label><input type="number" step="0.01" className="input" value={values.cost} onChange={(e) => set('cost', e.target.value)} /></div>
        <div><label className="label">Tax rate %</label><input type="number" step="0.01" className="input" value={values.taxRate} onChange={(e) => set('taxRate', e.target.value)} /></div>
      </div>
      <div className="flex items-center gap-3">
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={values.trackInventory} onChange={(e) => set('trackInventory', e.target.checked)} />
          Track inventory
        </label>
        {values.trackInventory && (
          <div className="flex items-center gap-2">
            <label className="label !mb-0">Reorder point</label>
            <input type="number" className="input w-24" value={values.reorderPoint} onChange={(e) => set('reorderPoint', e.target.value)} />
          </div>
        )}
      </div>
      <div className="flex gap-2">
        <button type="submit" disabled={saving} className="btn-primary">{saving ? 'Saving...' : 'Save product'}</button>
        <button type="button" className="btn-secondary" onClick={() => router.back()}>Cancel</button>
      </div>
    </form>
  );
}
