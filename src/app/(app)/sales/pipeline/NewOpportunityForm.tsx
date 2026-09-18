'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import CompanyContactPicker from '@/components/CompanyContactPicker';

export default function NewOpportunityForm() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState('');
  const [companyId, setCompanyId] = useState('');
  const [contactId, setContactId] = useState('');
  const [value, setValue] = useState('0');
  const [saving, setSaving] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    await fetch('/api/opportunities', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title, companyId: companyId || null, contactId: contactId || null, value: Number(value) }),
    });
    setSaving(false);
    setOpen(false);
    setTitle('');
    setValue('0');
    router.refresh();
  }

  if (!open) {
    return <button className="btn-primary mb-4" onClick={() => setOpen(true)}>+ New Opportunity</button>;
  }

  return (
    <form onSubmit={submit} className="card p-4 mb-4 space-y-3 max-w-xl">
      <input className="input" placeholder="Opportunity title" required value={title} onChange={(e) => setTitle(e.target.value)} />
      <CompanyContactPicker companyId={companyId} contactId={contactId} onCompanyChange={setCompanyId} onContactChange={setContactId} companyType="CUSTOMER" />
      <input type="number" step="0.01" className="input" placeholder="Estimated value" value={value} onChange={(e) => setValue(e.target.value)} />
      <div className="flex gap-2">
        <button type="submit" disabled={saving} className="btn-primary">{saving ? 'Saving...' : 'Create'}</button>
        <button type="button" className="btn-secondary" onClick={() => setOpen(false)}>Cancel</button>
      </div>
    </form>
  );
}
