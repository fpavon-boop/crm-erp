'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import Badge from '@/components/Badge';

interface User {
  id: string;
  name: string;
  email: string;
  role: string;
  active: boolean;
}

export default function UsersClient({ initial, currentUserId }: { initial: User[]; currentUserId: string }) {
  const router = useRouter();
  const [users, setUsers] = useState(initial);
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [role, setRole] = useState('SALES');
  const [password, setPassword] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function createUser(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    const res = await fetch('/api/users', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, email, role, password }),
    });
    setSaving(false);
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      setError(data.error?.formErrors?.join(', ') || 'Failed to create user');
      return;
    }
    const data = await res.json();
    setUsers((u) => [...u, data.user]);
    setName('');
    setEmail('');
    setPassword('');
    setOpen(false);
    router.refresh();
  }

  async function toggleActive(id: string, active: boolean) {
    setUsers((u) => u.map((usr) => (usr.id === id ? { ...usr, active } : usr)));
    await fetch(`/api/users/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ active }),
    });
  }

  async function changeRole(id: string, newRole: string) {
    setUsers((u) => u.map((usr) => (usr.id === id ? { ...usr, role: newRole } : usr)));
    await fetch(`/api/users/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ role: newRole }),
    });
  }

  async function remove(id: string) {
    if (!confirm('Delete this user?')) return;
    setUsers((u) => u.filter((usr) => usr.id !== id));
    await fetch(`/api/users/${id}`, { method: 'DELETE' });
  }

  return (
    <div>
      <button className="btn-primary mb-4" onClick={() => setOpen((o) => !o)}>{open ? 'Cancel' : '+ New User'}</button>

      {open && (
        <form onSubmit={createUser} className="card p-5 mb-4 space-y-3 max-w-lg">
          {error && <p className="text-sm text-red-600">{error}</p>}
          <input className="input" placeholder="Full name" required value={name} onChange={(e) => setName(e.target.value)} />
          <input className="input" type="email" placeholder="Email" required value={email} onChange={(e) => setEmail(e.target.value)} />
          <select className="input" value={role} onChange={(e) => setRole(e.target.value)}>
            <option value="ADMIN">Administrator</option>
            <option value="SALES">Sales</option>
            <option value="OPERATIONS">Operations</option>
            <option value="ACCOUNTING">Accounting</option>
          </select>
          <input className="input" type="password" placeholder="Temporary password (min 8 chars)" required minLength={8} value={password} onChange={(e) => setPassword(e.target.value)} />
          <button type="submit" disabled={saving} className="btn-primary">{saving ? 'Creating...' : 'Create user'}</button>
        </form>
      )}

      <div className="card overflow-x-auto">
        <table className="table-base">
          <thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Status</th><th /></tr></thead>
          <tbody>
            {users.map((u) => (
              <tr key={u.id}>
                <td className="font-medium">{u.name}</td>
                <td>{u.email}</td>
                <td>
                  <select className="input !py-1 !text-xs" value={u.role} onChange={(e) => changeRole(u.id, e.target.value)} disabled={u.id === currentUserId}>
                    <option value="ADMIN">Administrator</option>
                    <option value="SALES">Sales</option>
                    <option value="OPERATIONS">Operations</option>
                    <option value="ACCOUNTING">Accounting</option>
                  </select>
                </td>
                <td>
                  <button onClick={() => toggleActive(u.id, !u.active)} disabled={u.id === currentUserId}>
                    <Badge label={u.active ? 'active' : 'inactive'} />
                  </button>
                </td>
                <td>
                  {u.id !== currentUserId && (
                    <button className="text-red-500 hover:text-red-700 text-xs" onClick={() => remove(u.id)}>Delete</button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
