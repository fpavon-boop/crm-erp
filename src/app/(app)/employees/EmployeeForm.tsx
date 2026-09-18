'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

interface Values {
  id?: string;
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  position: string;
  department: string;
  hireDate: string;
  notes: string;
}

const EMPTY: Values = { firstName: '', lastName: '', email: '', phone: '', position: '', department: '', hireDate: '', notes: '' };

export default function EmployeeForm({ initial }: { initial?: Partial<Values> }) {
  const router = useRouter();
  const [values, setValues] = useState<Values>({ ...EMPTY, ...initial });
  const [saving, setSaving] = useState(false);

  function set<K extends keyof Values>(key: K, value: Values[K]) {
    setValues((v) => ({ ...v, [key]: value }));
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    const payload = { ...values, email: values.email || null, hireDate: values.hireDate || null };
    const res = await fetch(values.id ? `/api/employees/${values.id}` : '/api/employees', {
      method: values.id ? 'PUT' : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    setSaving(false);
    if (res.ok) {
      router.push('/employees');
      router.refresh();
    }
  }

  return (
    <form onSubmit={submit} className="card p-6 space-y-5 max-w-2xl">
      <div className="grid grid-cols-2 gap-4">
        <div><label className="label">First name *</label><input className="input" required value={values.firstName} onChange={(e) => set('firstName', e.target.value)} /></div>
        <div><label className="label">Last name *</label><input className="input" required value={values.lastName} onChange={(e) => set('lastName', e.target.value)} /></div>
      </div>
      <div className="grid grid-cols-2 gap-4">
        <div><label className="label">Email</label><input className="input" type="email" value={values.email} onChange={(e) => set('email', e.target.value)} /></div>
        <div><label className="label">Phone</label><input className="input" value={values.phone} onChange={(e) => set('phone', e.target.value)} /></div>
      </div>
      <div className="grid grid-cols-2 gap-4">
        <div><label className="label">Position</label><input className="input" value={values.position} onChange={(e) => set('position', e.target.value)} /></div>
        <div><label className="label">Department</label><input className="input" value={values.department} onChange={(e) => set('department', e.target.value)} /></div>
      </div>
      <div><label className="label">Hire date</label><input type="date" className="input" value={values.hireDate} onChange={(e) => set('hireDate', e.target.value)} /></div>
      <div><label className="label">Notes</label><textarea className="input" rows={3} value={values.notes} onChange={(e) => set('notes', e.target.value)} /></div>
      <div className="flex gap-2">
        <button type="submit" disabled={saving} className="btn-primary">{saving ? 'Saving...' : 'Save employee'}</button>
        <button type="button" className="btn-secondary" onClick={() => router.back()}>Cancel</button>
      </div>
    </form>
  );
}
