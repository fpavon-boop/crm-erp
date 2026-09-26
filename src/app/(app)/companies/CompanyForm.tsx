'use client';

import { useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { newIdempotencyKey } from '@/lib/idempotency-client';

interface CompanyFormValues {
  id?: string;
  name: string;
  type: string;
  taxId: string;
  industry: string;
  website: string;
  addressLine1: string;
  addressLine2: string;
  city: string;
  state: string;
  postalCode: string;
  country: string;
  notes: string;
  phone: string;
  email: string;
}

const EMPTY: CompanyFormValues = {
  name: '',
  type: 'CUSTOMER',
  taxId: '',
  industry: '',
  website: '',
  addressLine1: '',
  addressLine2: '',
  city: '',
  state: '',
  postalCode: '',
  country: '',
  notes: '',
  phone: '',
  email: '',
};

interface DuplicateCompanyMatch {
  id: string;
  name: string;
  type: string;
}

export default function CompanyForm({ initial }: { initial?: Partial<CompanyFormValues> }) {
  const router = useRouter();
  const [values, setValues] = useState<CompanyFormValues>({ ...EMPTY, ...initial });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [duplicates, setDuplicates] = useState<DuplicateCompanyMatch[] | null>(null);
  // Phase 13: stable across a "Create anyway" retry of the same submission
  // (so a network retry / double-click can't create the record twice),
  // regenerated whenever the user actually edits a field (a genuinely
  // different submission). Not used at all on an edit (values.id set).
  const idempotencyKeyRef = useRef(newIdempotencyKey());

  function set<K extends keyof CompanyFormValues>(key: K, value: CompanyFormValues[K]) {
    setValues((v) => ({ ...v, [key]: value }));
    idempotencyKeyRef.current = newIdempotencyKey();
    setDuplicates(null); // editing after seeing a warning re-opens the question
  }

  async function submit(confirmDuplicate: boolean) {
    setSaving(true);
    setError(null);

    const payload = {
      name: values.name,
      type: values.type,
      taxId: values.taxId || null,
      industry: values.industry || null,
      website: values.website || null,
      addressLine1: values.addressLine1 || null,
      addressLine2: values.addressLine2 || null,
      city: values.city || null,
      state: values.state || null,
      postalCode: values.postalCode || null,
      country: values.country || null,
      notes: values.notes || null,
      phones: values.phone ? [{ label: 'main', number: values.phone }] : [],
      emails: values.email ? [{ label: 'main', address: values.email }] : [],
      ...(confirmDuplicate ? { confirmDuplicate: true } : {}),
      ...(values.id ? {} : { idempotencyKey: idempotencyKeyRef.current }),
    };

    const res = await fetch(values.id ? `/api/companies/${values.id}` : '/api/companies', {
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
      setError(data.error?.formErrors?.join(', ') || 'Failed to save company');
      return;
    }
    const data = await res.json();
    router.push(`/companies/${data.company.id}`);
    router.refresh();
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    submit(false);
  }

  return (
    <form onSubmit={handleSubmit} className="card p-6 space-y-5 max-w-3xl">
      {error && <p className="text-sm text-red-600">{error}</p>}

      {duplicates && duplicates.length > 0 && (
        <div className="card p-4 border-amber-300 bg-amber-50 text-amber-900 text-sm space-y-2">
          <p className="font-medium">
            {duplicates.length === 1 ? 'A company with this name already exists:' : 'Companies with this name already exist:'}
          </p>
          <ul className="list-disc list-inside">
            {duplicates.map((m) => (
              <li key={m.id}>
                <a href={`/companies/${m.id}`} target="_blank" rel="noreferrer" className="text-blue-700 hover:underline">{m.name}</a>
                {' '}<span className="text-amber-700">({m.type})</span>
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
          <label className="label">Company name *</label>
          <input className="input" required value={values.name} onChange={(e) => set('name', e.target.value)} />
        </div>
        <div>
          <label className="label">Type</label>
          <select className="input" value={values.type} onChange={(e) => set('type', e.target.value)}>
            <option value="CUSTOMER">Customer</option>
            <option value="SUPPLIER">Supplier</option>
            <option value="BOTH">Both</option>
            <option value="PARTNER">Partner</option>
          </select>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className="label">Tax ID</label>
          <input className="input" value={values.taxId} onChange={(e) => set('taxId', e.target.value)} />
        </div>
        <div>
          <label className="label">Industry</label>
          <input className="input" value={values.industry} onChange={(e) => set('industry', e.target.value)} />
        </div>
      </div>

      <div>
        <label className="label">Website</label>
        <input className="input" value={values.website} onChange={(e) => set('website', e.target.value)} />
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className="label">Phone</label>
          <input className="input" value={values.phone} onChange={(e) => set('phone', e.target.value)} />
        </div>
        <div>
          <label className="label">Email</label>
          <input className="input" type="email" value={values.email} onChange={(e) => set('email', e.target.value)} />
        </div>
      </div>

      <fieldset className="border border-slate-200 rounded-md p-4">
        <legend className="text-sm font-medium text-slate-700 px-1">Address</legend>
        <div className="space-y-3">
          <input
            className="input"
            placeholder="Address line 1"
            value={values.addressLine1}
            onChange={(e) => set('addressLine1', e.target.value)}
          />
          <input
            className="input"
            placeholder="Address line 2"
            value={values.addressLine2}
            onChange={(e) => set('addressLine2', e.target.value)}
          />
          <div className="grid grid-cols-3 gap-3">
            <input className="input" placeholder="City" value={values.city} onChange={(e) => set('city', e.target.value)} />
            <input className="input" placeholder="State" value={values.state} onChange={(e) => set('state', e.target.value)} />
            <input
              className="input"
              placeholder="Postal code"
              value={values.postalCode}
              onChange={(e) => set('postalCode', e.target.value)}
            />
          </div>
          <input className="input" placeholder="Country" value={values.country} onChange={(e) => set('country', e.target.value)} />
        </div>
      </fieldset>

      <div>
        <label className="label">Notes</label>
        <textarea className="input" rows={3} value={values.notes} onChange={(e) => set('notes', e.target.value)} />
      </div>

      <div className="flex gap-2">
        <button type="submit" disabled={saving} className="btn-primary">
          {saving ? 'Saving...' : 'Save company'}
        </button>
        <button type="button" className="btn-secondary" onClick={() => router.back()}>
          Cancel
        </button>
      </div>
    </form>
  );
}
