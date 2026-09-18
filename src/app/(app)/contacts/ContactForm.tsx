'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';

interface Company {
  id: string;
  name: string;
}

interface ContactFormValues {
  id?: string;
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  mobile: string;
  position: string;
  companyId: string;
  notes: string;
}

const EMPTY: ContactFormValues = {
  firstName: '',
  lastName: '',
  email: '',
  phone: '',
  mobile: '',
  position: '',
  companyId: '',
  notes: '',
};

export default function ContactForm({ initial }: { initial?: Partial<ContactFormValues> }) {
  const router = useRouter();
  const [values, setValues] = useState<ContactFormValues>({ ...EMPTY, ...initial });
  const [companies, setCompanies] = useState<Company[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch('/api/companies')
      .then((r) => r.json())
      .then((d) => setCompanies(d.companies || []));
  }, []);

  function set<K extends keyof ContactFormValues>(key: K, value: ContactFormValues[K]) {
    setValues((v) => ({ ...v, [key]: value }));
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);

    const payload = {
      firstName: values.firstName,
      lastName: values.lastName,
      email: values.email || null,
      phone: values.phone || null,
      mobile: values.mobile || null,
      position: values.position || null,
      companyId: values.companyId || null,
      notes: values.notes || null,
    };

    const res = await fetch(values.id ? `/api/contacts/${values.id}` : '/api/contacts', {
      method: values.id ? 'PUT' : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    setSaving(false);
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      setError(data.error?.formErrors?.join(', ') || 'Failed to save contact');
      return;
    }
    const data = await res.json();
    router.push(`/contacts/${data.contact.id}`);
    router.refresh();
  }

  return (
    <form onSubmit={handleSubmit} className="card p-6 space-y-5 max-w-2xl">
      {error && <p className="text-sm text-red-600">{error}</p>}
      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className="label">First name *</label>
          <input className="input" required value={values.firstName} onChange={(e) => set('firstName', e.target.value)} />
        </div>
        <div>
          <label className="label">Last name *</label>
          <input className="input" required value={values.lastName} onChange={(e) => set('lastName', e.target.value)} />
        </div>
      </div>
      <div>
        <label className="label">Company</label>
        <select className="input" value={values.companyId} onChange={(e) => set('companyId', e.target.value)}>
          <option value="">— None —</option>
          {companies.map((c) => (
            <option key={c.id} value={c.id}>{c.name}</option>
          ))}
        </select>
      </div>
      <div>
        <label className="label">Position</label>
        <input className="input" value={values.position} onChange={(e) => set('position', e.target.value)} />
      </div>
      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className="label">Email</label>
          <input className="input" type="email" value={values.email} onChange={(e) => set('email', e.target.value)} />
        </div>
        <div>
          <label className="label">Phone</label>
          <input className="input" value={values.phone} onChange={(e) => set('phone', e.target.value)} />
        </div>
      </div>
      <div>
        <label className="label">Mobile / WhatsApp number</label>
        <input className="input" value={values.mobile} onChange={(e) => set('mobile', e.target.value)} placeholder="+1 555 000 0000" />
      </div>
      <div>
        <label className="label">Notes</label>
        <textarea className="input" rows={3} value={values.notes} onChange={(e) => set('notes', e.target.value)} />
      </div>
      <div className="flex gap-2">
        <button type="submit" disabled={saving} className="btn-primary">{saving ? 'Saving...' : 'Save contact'}</button>
        <button type="button" className="btn-secondary" onClick={() => router.back()}>Cancel</button>
      </div>
    </form>
  );
}
