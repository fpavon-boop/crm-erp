'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import NumberSetup from './NumberSetup';

interface Account { id: string; label: string; phoneNumberId: string; businessAccountId: string; displayPhoneNumber: string | null; active: boolean }
interface Template { id: string; name: string; language: string; category: string; bodyText: string }

export default function WhatsAppSettingsClient({ accounts, templates }: { accounts: Account[]; templates: Template[] }) {
  const router = useRouter();
  const [accountForm, setAccountForm] = useState({ label: '', phoneNumberId: '', businessAccountId: '', displayPhoneNumber: '', accessToken: '' });
  const [templateForm, setTemplateForm] = useState({ name: '', language: 'en_US', category: 'UTILITY', bodyText: '' });
  const [savingAccount, setSavingAccount] = useState(false);
  const [savingTemplate, setSavingTemplate] = useState(false);
  const [activatingId, setActivatingId] = useState<string | null>(null);
  const [activateError, setActivateError] = useState<string | null>(null);

  async function activateAccount(id: string) {
    setActivatingId(id);
    setActivateError(null);
    const res = await fetch(`/api/whatsapp/accounts/${id}/activate`, { method: 'POST' });
    setActivatingId(null);
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      setActivateError(typeof data.error === 'string' ? data.error : 'Could not activate this account.');
      return;
    }
    router.refresh();
  }

  async function submitAccount(e: React.FormEvent) {
    e.preventDefault();
    setSavingAccount(true);
    const res = await fetch('/api/whatsapp/accounts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(accountForm),
    });
    setSavingAccount(false);
    if (res.ok) {
      setAccountForm({ label: '', phoneNumberId: '', businessAccountId: '', displayPhoneNumber: '', accessToken: '' });
      router.refresh();
    }
  }

  async function submitTemplate(e: React.FormEvent) {
    e.preventDefault();
    setSavingTemplate(true);
    const res = await fetch('/api/whatsapp/templates', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(templateForm),
    });
    setSavingTemplate(false);
    if (res.ok) {
      setTemplateForm({ name: '', language: 'en_US', category: 'UTILITY', bodyText: '' });
      router.refresh();
    }
  }

  return (
    <div className="space-y-6">
      {accounts.length > 0 && <NumberSetup />}
      <div className="card p-5">
        <h2 className="font-semibold text-slate-800 mb-1">Meta WhatsApp Business account</h2>
        <p className="text-xs text-slate-500 mb-3">
          From Meta Business Manager &gt; WhatsApp &gt; API Setup: Phone number ID, WhatsApp Business Account ID, and a
          permanent access token (System User token recommended). See README for full setup steps.
        </p>
        <form onSubmit={submitAccount} className="grid grid-cols-2 gap-3">
          <input className="input" placeholder="Label" required value={accountForm.label} onChange={(e) => setAccountForm((f) => ({ ...f, label: e.target.value }))} />
          <input className="input" placeholder="Display phone number" value={accountForm.displayPhoneNumber} onChange={(e) => setAccountForm((f) => ({ ...f, displayPhoneNumber: e.target.value }))} />
          <input className="input" placeholder="Phone number ID" required value={accountForm.phoneNumberId} onChange={(e) => setAccountForm((f) => ({ ...f, phoneNumberId: e.target.value }))} />
          <input className="input" placeholder="Business account ID" required value={accountForm.businessAccountId} onChange={(e) => setAccountForm((f) => ({ ...f, businessAccountId: e.target.value }))} />
          <input className="input col-span-2" type="password" placeholder="Access token" required value={accountForm.accessToken} onChange={(e) => setAccountForm((f) => ({ ...f, accessToken: e.target.value }))} />
          <button type="submit" disabled={savingAccount} className="btn-primary col-span-2">{savingAccount ? 'Saving...' : 'Save account'}</button>
        </form>
        {activateError && <p className="text-sm text-red-600 mt-3">{activateError}</p>}
        <ul className="text-sm mt-4 divide-y divide-slate-100">
          {accounts.map((a) => (
            <li key={a.id} className="py-2 flex items-center justify-between gap-3">
              <span>
                {a.label} — {a.displayPhoneNumber || a.phoneNumberId}
                {a.active && <span className="ml-2 text-xs font-medium text-green-700">(active — sending uses this number)</span>}
              </span>
              {!a.active && (
                <button
                  type="button"
                  className="text-blue-600 hover:text-blue-800 text-xs shrink-0"
                  disabled={activatingId === a.id}
                  onClick={() => activateAccount(a.id)}
                >
                  {activatingId === a.id ? 'Activating...' : 'Set as active'}
                </button>
              )}
            </li>
          ))}
        </ul>
      </div>

      <div className="card p-5">
        <h2 className="font-semibold text-slate-800 mb-1">Message templates</h2>
        <p className="text-xs text-slate-500 mb-3">
          Templates must be created and approved in Meta Business Manager first. Record them here for reference and
          for use in automation rules and quick-send.
        </p>
        <form onSubmit={submitTemplate} className="grid grid-cols-2 gap-3">
          <input className="input" placeholder="Template name (must match Meta exactly)" required value={templateForm.name} onChange={(e) => setTemplateForm((f) => ({ ...f, name: e.target.value }))} />
          <input className="input" placeholder="Language code (e.g. en_US)" value={templateForm.language} onChange={(e) => setTemplateForm((f) => ({ ...f, language: e.target.value }))} />
          <select className="input" value={templateForm.category} onChange={(e) => setTemplateForm((f) => ({ ...f, category: e.target.value }))}>
            <option value="UTILITY">Utility</option>
            <option value="MARKETING">Marketing</option>
            <option value="AUTHENTICATION">Authentication</option>
          </select>
          <input className="input col-span-2" placeholder="Body text (for reference)" value={templateForm.bodyText} onChange={(e) => setTemplateForm((f) => ({ ...f, bodyText: e.target.value }))} />
          <button type="submit" disabled={savingTemplate} className="btn-primary col-span-2">{savingTemplate ? 'Saving...' : 'Save template reference'}</button>
        </form>
        <ul className="text-sm mt-4 divide-y divide-slate-100">
          {templates.map((t) => (
            <li key={t.id} className="py-2">
              <span className="font-medium">{t.name}</span> <span className="text-xs text-slate-400">({t.category}, {t.language})</span>
              <p className="text-slate-500">{t.bodyText}</p>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
