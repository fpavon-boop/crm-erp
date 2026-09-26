'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { newIdempotencyKey } from '@/lib/idempotency-client';

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

interface DuplicateContactMatch {
  id: string;
  firstName: string;
  lastName: string;
  email: string | null;
}

export default function ContactForm({ initial }: { initial?: Partial<ContactFormValues> }) {
  const router = useRouter();
  const [values, setValues] = useState<ContactFormValues>({ ...EMPTY, ...initial });
  const [companies, setCompanies] = useState<Company[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [duplicates, setDuplicates] = useState<DuplicateContactMatch[] | null>(null);
  // Phase 13: see the matching comment in CompanyForm.tsx — stable across
  // a "Create anyway" retry, regenerated on an actual field edit, unused
  // on an edit of an existing contact.
  const idempotencyKeyRef = useRef(newIdempotencyKey());

  useEffect(() => {
    fetch('/api/companies')
      .then((r) => r.json())
      .then((d) => setCompanies(d.companies || []));
  }, []);

  function set<K extends keyof ContactFormValues>(key: K, value: ContactFormValues[K]) {
    setValues((v) => ({ ...v, [key]: value }));
    setDuplicates(null); // editing after seeing a warning re-opens the question
    idempotencyKeyRef.current = newIdempotencyKey();
  }

  async function submit(confirmDuplicate: boolean) {
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
      ...(confirmDuplicate ? { confirmDuplicate: true } : {}),
      ...(values.id ? {} : { idempotencyKey: idempotencyKeyRef.current }),
    };

    const res = await fetch(values.id ? `/api/contacts/${values.id}` : '/api/contacts', {
      method: values.id ? 'PUT' : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    setSaving(false);
    if (res.status === 409) {
      const data = await res.json().catch(() => ({}));
      if (data.duplicate) {
        setDuplicates(data.matches || []);
        return;
      }
    }
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      setError(data.error?.formErrors?.join(', ') || 'Failed to save contact');
      return;
    }
    const data = await res.json();
    router.push(`/contacts/${data.contact.id}`);
    router.refresh();
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    submit(false);
  }

  return (
    <form onSubmit={handleSubmit} className="card p-6 space-y-5 max-w-2xl">
      {error && <p className="text-sm text-red-600">{error}</p>}

      {duplicates && duplicates.length > 0 && (
        <div className="card p-4 border-amber-300 bg-amber-50 text-amber-900 text-sm space-y-2">
          <p className="font-medium">
            {duplicates.length === 1 ? 'A matching contact already exists:' : 'Matching contacts already exist:'}
          </p>
          <ul className="list-disc list-inside">
            {duplicates.map((m) => (
              <li key={m.id}>
                <a href={`/contacts/${m.id}`} target="_blank" rel="noreferrer" className="text-blue-700 hover:underline">
                  {m.firstName} {m.lastName}
                </a>
                {m.email && <span className="text-amber-700"> ({m.email})</span>}
              </li>
            ))}
          </ul>
          <button type="button" className="btn-secondary !py-1 !text-xs" disabled={saving} onClick={() => submit(true)}>
            Create anyway
          </button>
        </div>
      )}
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
