'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

export function AddNoteForm({ companyId }: { companyId: string }) {
  const router = useRouter();
  const [body, setBody] = useState('');
  const [saving, setSaving] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!body.trim()) return;
    setSaving(true);
    await fetch(`/api/companies/${companyId}/notes`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ body }),
    });
    setBody('');
    setSaving(false);
    router.refresh();
  }

  return (
    <form onSubmit={submit} className="flex gap-2 mb-4">
      <input
        className="input"
        placeholder="Add a note..."
        value={body}
        onChange={(e) => setBody(e.target.value)}
      />
      <button className="btn-secondary shrink-0" disabled={saving} type="submit">
        {saving ? 'Saving...' : 'Add note'}
      </button>
    </form>
  );
}

export function UploadDocumentForm({ companyId }: { companyId: string }) {
  const router = useRouter();
  const [uploading, setUploading] = useState(false);

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const fileInput = form.elements.namedItem('file') as HTMLInputElement;
    if (!fileInput.files?.[0]) return;

    setUploading(true);
    const fd = new FormData();
    fd.append('file', fileInput.files[0]);
    await fetch(`/api/companies/${companyId}/documents`, { method: 'POST', body: fd });
    setUploading(false);
    form.reset();
    router.refresh();
  }

  return (
    <form onSubmit={submit} className="flex gap-2 mb-4 items-center">
      <input type="file" name="file" className="text-sm" />
      <button className="btn-secondary shrink-0" disabled={uploading} type="submit">
        {uploading ? 'Uploading...' : 'Upload document'}
      </button>
    </form>
  );
}

export function DeleteCompanyButton({ companyId }: { companyId: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  async function handleDelete() {
    if (!confirm('Delete this company? This cannot be undone.')) return;
    setBusy(true);
    const res = await fetch(`/api/companies/${companyId}`, { method: 'DELETE' });
    setBusy(false);
    if (res.ok) {
      router.push('/companies');
      router.refresh();
    } else {
      alert('Failed to delete company.');
    }
  }

  return (
    <button className="btn-danger" disabled={busy} onClick={handleDelete}>
      {busy ? 'Deleting...' : 'Delete'}
    </button>
  );
}
