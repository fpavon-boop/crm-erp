'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { formatDateTime } from '@/lib/format';

interface Site { id: string; name: string; baseUrl: string; lastSyncedAt: string | null; syncEnabled: boolean }

export default function WordPressSettingsClient({ initial }: { initial: Site[] }) {
  const router = useRouter();
  const [sites, setSites] = useState(initial);
  const [name, setName] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [saving, setSaving] = useState(false);
  const [syncingId, setSyncingId] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  async function addSite(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    const res = await fetch('/api/wordpress/sites', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, baseUrl }),
    });
    setSaving(false);
    if (res.ok) {
      const data = await res.json();
      setSites((s) => [...s, { ...data.site, lastSyncedAt: null }]);
      setName('');
      setBaseUrl('');
      router.refresh();
    }
  }

  async function sync(id: string, kind: 'content' | 'woocommerce') {
    setSyncingId(id);
    setMessage(null);
    const res = await fetch(`/api/wordpress/sites/${id}/${kind === 'content' ? 'sync' : 'sync-woocommerce'}`, { method: 'POST' });
    const data = await res.json();
    setSyncingId(null);
    setMessage(res.ok ? JSON.stringify(data) : `Error: ${data.error}`);
    router.refresh();
  }

  return (
    <div className="space-y-6">
      <form onSubmit={addSite} className="card p-5 space-y-3 max-w-lg">
        <h2 className="font-semibold text-slate-800">Connect a WordPress site</h2>
        <p className="text-xs text-slate-500">Uses the WORDPRESS_URL / WORDPRESS_USERNAME / WORDPRESS_APP_PASSWORD from your .env for authenticated calls (WooCommerce, form leads). Public content syncs without credentials.</p>
        <input className="input" placeholder="Site name" required value={name} onChange={(e) => setName(e.target.value)} />
        <input className="input" placeholder="https://www.example.com" required value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} />
        <button type="submit" disabled={saving} className="btn-primary">{saving ? 'Saving...' : 'Add site'}</button>
      </form>

      {message && <p className="text-xs text-slate-500">{message}</p>}

      <div className="card overflow-x-auto">
        <table className="table-base">
          <thead><tr><th>Name</th><th>URL</th><th>Last synced</th><th /></tr></thead>
          <tbody>
            {sites.map((s) => (
              <tr key={s.id}>
                <td className="font-medium">{s.name}</td>
                <td>{s.baseUrl}</td>
                <td>{s.lastSyncedAt ? formatDateTime(s.lastSyncedAt) : 'never'}</td>
                <td className="flex gap-2 py-2">
                  <button className="btn-secondary !py-1 !px-2 text-xs" disabled={syncingId === s.id} onClick={() => sync(s.id, 'content')}>Sync content</button>
                  <button className="btn-secondary !py-1 !px-2 text-xs" disabled={syncingId === s.id} onClick={() => sync(s.id, 'woocommerce')}>Sync WooCommerce</button>
                </td>
              </tr>
            ))}
            {sites.length === 0 && <tr><td colSpan={4} className="text-center text-slate-500 py-8">No sites connected yet.</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}
