'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

export default function WarehouseForm() {
  const router = useRouter();
  const [name, setName] = useState('');
  const [address, setAddress] = useState('');
  const [saving, setSaving] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    setSaving(true);
    await fetch('/api/warehouses', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, address: address || null }),
    });
    setName('');
    setAddress('');
    setSaving(false);
    router.refresh();
  }

  return (
    <form onSubmit={submit} className="flex gap-2 items-end">
      <div>
        <label className="label">Name</label>
        <input className="input" value={name} onChange={(e) => setName(e.target.value)} required />
      </div>
      <div>
        <label className="label">Address</label>
        <input className="input" value={address} onChange={(e) => setAddress(e.target.value)} />
      </div>
      <button type="submit" disabled={saving} className="btn-primary shrink-0">{saving ? 'Saving...' : 'Add warehouse'}</button>
    </form>
  );
}
