'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

interface Account {
  id: string;
  label: string;
  emailAddress: string;
  imapHost: string;
  smtpHost: string;
  active: boolean;
  lastSyncedAt: string | null;
}

export default function AccountsClient({ initial }: { initial: Account[] }) {
  const router = useRouter();
  const [accounts, setAccounts] = useState(initial);
  const [form, setForm] = useState({
    label: '', emailAddress: '', imapHost: 'imap.hostinger.com', imapPort: '993', smtpHost: 'smtp.hostinger.com', smtpPort: '465', username: '', password: '',
  });
  const [saving, setSaving] = useState(false);

  function set<K extends keyof typeof form>(key: K, value: string) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    const res = await fetch('/api/email-accounts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...form,
        imapPort: Number(form.imapPort),
        smtpPort: Number(form.smtpPort),
        imapSecure: true,
        smtpSecure: Number(form.smtpPort) === 465,
      }),
    });
    setSaving(false);
    if (res.ok) {
      router.refresh();
      setForm({ label: '', emailAddress: '', imapHost: '', imapPort: '993', smtpHost: '', smtpPort: '587', username: '', password: '' });
      const data = await fetch('/api/email-accounts').then((r) => r.json());
      setAccounts(data.accounts || []);
    }
  }

  async function remove(id: string) {
    if (!confirm('Disconnect this mailbox?')) return;
    setAccounts((a) => a.filter((x) => x.id !== id));
    await fetch(`/api/email-accounts/${id}`, { method: 'DELETE' });
  }

  async function sync(id: string) {
    await fetch(`/api/email-accounts/${id}/sync`, { method: 'POST' });
    router.refresh();
  }

  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
      <form onSubmit={submit} className="card p-6 space-y-3">
        <h2 className="font-semibold text-slate-800 mb-1">Connect a mailbox</h2>
        <p className="text-xs text-slate-500 mb-3">Standard IMAP/SMTP credentials. For Gmail/Outlook, use an app password.</p>
        <input className="input" placeholder="Label (e.g. Support inbox)" required value={form.label} onChange={(e) => set('label', e.target.value)} />
        <input className="input" type="email" placeholder="Email address" required value={form.emailAddress} onChange={(e) => set('emailAddress', e.target.value)} />
        <div className="grid grid-cols-2 gap-2">
          <input className="input" placeholder="IMAP host" required value={form.imapHost} onChange={(e) => set('imapHost', e.target.value)} />
          <input className="input" placeholder="IMAP port" value={form.imapPort} onChange={(e) => set('imapPort', e.target.value)} />
        </div>
        <div className="grid grid-cols-2 gap-2">
          <input className="input" placeholder="SMTP host" required value={form.smtpHost} onChange={(e) => set('smtpHost', e.target.value)} />
          <input className="input" placeholder="SMTP port" value={form.smtpPort} onChange={(e) => set('smtpPort', e.target.value)} />
        </div>
        <input className="input" placeholder="Username" required value={form.username} onChange={(e) => set('username', e.target.value)} />
        <input className="input" type="password" placeholder="Password / app password" required value={form.password} onChange={(e) => set('password', e.target.value)} />
        <button type="submit" disabled={saving} className="btn-primary">{saving ? 'Connecting...' : 'Connect mailbox'}</button>
      </form>

      <div className="card p-6">
        <h2 className="font-semibold text-slate-800 mb-3">Connected mailboxes</h2>
        <ul className="text-sm divide-y divide-slate-100">
          {accounts.map((a) => (
            <li key={a.id} className="py-3">
              <div className="flex justify-between items-center">
                <div>
                  <p className="font-medium">{a.label}</p>
                  <p className="text-xs text-slate-500">{a.emailAddress}</p>
                  <p className="text-xs text-slate-400">Last synced: {a.lastSyncedAt ? new Date(a.lastSyncedAt).toLocaleString() : 'never'}</p>
                </div>
                <div className="flex gap-2">
                  <button className="btn-secondary !py-1 !px-2 text-xs" onClick={() => sync(a.id)}>Sync</button>
                  <button className="text-red-500 hover:text-red-700 text-xs" onClick={() => remove(a.id)}>Remove</button>
                </div>
              </div>
            </li>
          ))}
          {accounts.length === 0 && <p className="text-slate-400">No mailboxes connected yet.</p>}
        </ul>
      </div>
    </div>
  );
}
