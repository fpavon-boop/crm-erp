'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { EXPENSE_CATEGORIES, PAYMENT_METHODS } from '@/lib/finance';
import { money, formatDate } from '@/lib/format';

interface Expense {
  id: string;
  expenseDate: string;
  category: string;
  payee: string | null;
  description: string | null;
  amount: number;
  method: string;
  reference: string | null;
}

const today = () => new Date().toISOString().slice(0, 10);

export default function ExpensesClient({ initial }: { initial: Expense[] }) {
  const router = useRouter();
  const [expenses, setExpenses] = useState(initial);
  const [form, setForm] = useState({
    expenseDate: today(),
    category: EXPENSE_CATEGORIES[0] as string,
    payee: '',
    description: '',
    amount: '',
    method: PAYMENT_METHODS[0] as string,
    reference: '',
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const set = (k: keyof typeof form, v: string) => setForm((f) => ({ ...f, [k]: v }));

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    const res = await fetch('/api/expenses', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...form,
        payee: form.payee || null,
        description: form.description || null,
        reference: form.reference || null,
        amount: Number(form.amount),
      }),
    });
    setSaving(false);
    if (!res.ok) {
      setError('Could not save the expense. Check the date and amount.');
      return;
    }
    const { expense } = await res.json();
    setExpenses((list) => [
      { ...expense, expenseDate: expense.expenseDate, amount: Number(expense.amount) },
      ...list,
    ]);
    setForm((f) => ({ ...f, payee: '', description: '', amount: '', reference: '' }));
    router.refresh();
  }

  async function remove(id: string) {
    if (!confirm('Delete this expense?')) return;
    const res = await fetch(`/api/expenses/${id}`, { method: 'DELETE' });
    if (res.ok) {
      setExpenses((list) => list.filter((x) => x.id !== id));
      router.refresh();
    }
  }

  const total = expenses.reduce((sum, x) => sum + x.amount, 0);

  return (
    <div className="space-y-6">
      <form onSubmit={submit} className="card p-5 grid grid-cols-1 md:grid-cols-4 gap-3">
        {error && <p className="md:col-span-4 text-sm text-red-600">{error}</p>}
        <div><label className="label">Date *</label><input type="date" required className="input" value={form.expenseDate} onChange={(e) => set('expenseDate', e.target.value)} /></div>
        <div>
          <label className="label">Category *</label>
          <select className="input" value={form.category} onChange={(e) => set('category', e.target.value)}>
            {EXPENSE_CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
        </div>
        <div><label className="label">Amount *</label><input type="number" step="0.01" min="0.01" required className="input" value={form.amount} onChange={(e) => set('amount', e.target.value)} /></div>
        <div>
          <label className="label">Paid by</label>
          <select className="input" value={form.method} onChange={(e) => set('method', e.target.value)}>
            {PAYMENT_METHODS.map((m) => <option key={m} value={m}>{m}</option>)}
          </select>
        </div>
        <div className="md:col-span-2"><label className="label">Paid to</label><input className="input" placeholder="Vendor or person" value={form.payee} onChange={(e) => set('payee', e.target.value)} /></div>
        <div className="md:col-span-2"><label className="label">Reference</label><input className="input" placeholder="Check number, receipt no." value={form.reference} onChange={(e) => set('reference', e.target.value)} /></div>
        <div className="md:col-span-4"><label className="label">Notes</label><input className="input" value={form.description} onChange={(e) => set('description', e.target.value)} /></div>
        <div className="md:col-span-4"><button type="submit" disabled={saving} className="btn-primary">{saving ? 'Saving...' : 'Add expense'}</button></div>
      </form>

      <div className="card overflow-x-auto">
        <table className="table-base">
          <thead><tr><th>Date</th><th>Category</th><th>Paid to</th><th>Notes</th><th>Method</th><th className="text-right">Amount</th><th /></tr></thead>
          <tbody>
            {expenses.map((x) => (
              <tr key={x.id}>
                <td>{formatDate(x.expenseDate)}</td>
                <td className="font-medium">{x.category}</td>
                <td>{x.payee || '—'}</td>
                <td className="text-slate-500">{x.description || '—'}</td>
                <td>{x.method}{x.reference ? ` · ${x.reference}` : ''}</td>
                <td className="text-right">{money(x.amount)}</td>
                <td><button className="text-red-500 hover:text-red-700 text-xs" onClick={() => remove(x.id)}>Delete</button></td>
              </tr>
            ))}
            {expenses.length === 0 && <tr><td colSpan={7} className="text-center text-slate-500 py-8">No expenses yet.</td></tr>}
          </tbody>
          {expenses.length > 0 && (
            <tfoot><tr><td colSpan={5} className="font-semibold pt-3">Total shown</td><td className="text-right font-semibold pt-3">{money(total)}</td><td /></tr></tfoot>
          )}
        </table>
      </div>
    </div>
  );
}
