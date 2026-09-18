'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import Badge from '@/components/Badge';

interface Rule {
  id: string;
  name: string;
  trigger: string;
  active: boolean;
  actions: unknown;
}

const TRIGGERS = [
  'EMAIL_RECEIVED_NO_REPLY',
  'INVOICE_OVERDUE',
  'ORDER_PENDING',
  'LOW_STOCK',
  'ORDER_STATUS_CHANGED',
  'INVOICE_CREATED',
  'SCHEDULE',
];

export default function AutomationsClient({ initial }: { initial: Rule[] }) {
  const router = useRouter();
  const [rules, setRules] = useState(initial);
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [trigger, setTrigger] = useState('LOW_STOCK');
  const [actionsJson, setActionsJson] = useState('[{"kind":"create_task","title":"Follow up"}]');
  const [saving, setSaving] = useState(false);
  const [running, setRunning] = useState(false);
  const [runResult, setRunResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function createRule(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    let actions: unknown;
    try {
      actions = JSON.parse(actionsJson);
    } catch {
      setError('Actions must be valid JSON (an array of action objects).');
      return;
    }
    setSaving(true);
    const res = await fetch('/api/automations/rules', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, trigger, actions }),
    });
    setSaving(false);
    if (!res.ok) {
      setError('Failed to create rule.');
      return;
    }
    const data = await res.json();
    setRules((r) => [data.rule, ...r]);
    setOpen(false);
    setName('');
    router.refresh();
  }

  async function toggleActive(id: string, active: boolean) {
    setRules((r) => r.map((rule) => (rule.id === id ? { ...rule, active } : rule)));
    await fetch(`/api/automations/rules/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ active }),
    });
  }

  async function remove(id: string) {
    if (!confirm('Delete this rule?')) return;
    setRules((r) => r.filter((rule) => rule.id !== id));
    await fetch(`/api/automations/rules/${id}`, { method: 'DELETE' });
  }

  async function runNow() {
    setRunning(true);
    setRunResult(null);
    const res = await fetch('/api/automations/run', { method: 'POST' });
    const data = await res.json();
    setRunning(false);
    setRunResult(JSON.stringify(data.results));
    router.refresh();
  }

  return (
    <div>
      <div className="flex gap-2 mb-4">
        <button className="btn-primary" onClick={() => setOpen((o) => !o)}>{open ? 'Cancel' : '+ New Rule'}</button>
        <button className="btn-secondary" onClick={runNow} disabled={running}>{running ? 'Running...' : 'Run automations now'}</button>
        {runResult && <span className="text-xs text-slate-500 self-center">{runResult}</span>}
      </div>

      {open && (
        <form onSubmit={createRule} className="card p-5 mb-4 space-y-3 max-w-xl">
          {error && <p className="text-sm text-red-600">{error}</p>}
          <input className="input" placeholder="Rule name" required value={name} onChange={(e) => setName(e.target.value)} />
          <select className="input" value={trigger} onChange={(e) => setTrigger(e.target.value)}>
            {TRIGGERS.map((t) => <option key={t} value={t}>{t.replace(/_/g, ' ')}</option>)}
          </select>
          <div>
            <label className="label">Actions (JSON array)</label>
            <textarea className="input font-mono text-xs" rows={4} value={actionsJson} onChange={(e) => setActionsJson(e.target.value)} />
            <p className="text-xs text-slate-400 mt-1">
              Supported actions: {'{'}&quot;kind&quot;:&quot;create_task&quot;,&quot;title&quot;:&quot;...&quot;{'}'} or {'{'}&quot;kind&quot;:&quot;send_whatsapp_template&quot;,&quot;to&quot;:&quot;+1...&quot;,&quot;templateName&quot;:&quot;...&quot;{'}'}
            </p>
          </div>
          <button type="submit" disabled={saving} className="btn-primary">{saving ? 'Saving...' : 'Create rule'}</button>
        </form>
      )}

      <div className="card overflow-x-auto">
        <table className="table-base">
          <thead><tr><th>Name</th><th>Trigger</th><th>Status</th><th /></tr></thead>
          <tbody>
            {rules.map((r) => (
              <tr key={r.id}>
                <td className="font-medium">{r.name}</td>
                <td>{r.trigger.replace(/_/g, ' ')}</td>
                <td>
                  <button onClick={() => toggleActive(r.id, !r.active)}>
                    <Badge label={r.active ? 'active' : 'inactive'} />
                  </button>
                </td>
                <td><button className="text-red-500 hover:text-red-700 text-xs" onClick={() => remove(r.id)}>Delete</button></td>
              </tr>
            ))}
            {rules.length === 0 && <tr><td colSpan={4} className="text-center text-slate-500 py-8">No custom rules yet. Built-in automations (overdue invoices, low stock, pending orders, unanswered emails) still run automatically.</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}
