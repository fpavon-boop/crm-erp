'use client';

import { useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { EXPENSE_CATEGORIES, PAYMENT_METHODS } from '@/lib/finance';
import { money, formatDate } from '@/lib/format';

export interface BillRow {
  id: string;
  status: string;
  kind: string;
  vendor: string | null;
  invoiceNumber: string | null;
  amount: number | null;
  billDate: string | null;
  dueDate: string | null;
  category: string | null;
  paid: boolean;
  paymentMethod: string | null;
  notes: string | null;
  fileName: string | null;
  hasFile: boolean;
  source: string;
  createdAt: string;
}

const CSV_TEMPLATE =
  'date,vendor,invoice,amount,due,type,category,paid,method,notes\n' +
  '2026-09-03,Acme Refractory,INV-1042,1250.00,2026-10-03,bill,,no,,September firebrick order\n' +
  '2026-09-05,Shell,,84.20,,expense,Fuel / Vehicle,yes,Card,Truck fuel\n';

/** Minimal CSV reader (handles quotes, commas and line breaks inside quotes). */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i += 1; }
      else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i += 1;
      row.push(cell); cell = '';
      if (row.some((v) => v.trim() !== '')) rows.push(row);
      row = [];
    } else cell += c;
  }
  row.push(cell);
  if (row.some((v) => v.trim() !== '')) rows.push(row);
  return rows;
}

function toIsoDate(value: string): string | null {
  const v = value.trim();
  if (!v) return null;
  const us = v.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (us) {
    const year = us[3].length === 2 ? `20${us[3]}` : us[3];
    return `${year}-${us[1].padStart(2, '0')}-${us[2].padStart(2, '0')}`;
  }
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

const HEADER_ALIASES: Record<string, string> = {
  date: 'billDate', billdate: 'billDate', 'bill date': 'billDate', 'invoice date': 'billDate',
  vendor: 'vendor', supplier: 'vendor', payee: 'vendor', 'paid to': 'vendor', name: 'vendor',
  invoice: 'invoiceNumber', 'invoice #': 'invoiceNumber', 'invoice no': 'invoiceNumber', number: 'invoiceNumber', reference: 'invoiceNumber',
  amount: 'amount', total: 'amount',
  due: 'dueDate', 'due date': 'dueDate', duedate: 'dueDate',
  type: 'kind', kind: 'kind',
  category: 'category',
  paid: 'paid',
  method: 'paymentMethod', 'payment method': 'paymentMethod',
  notes: 'notes', description: 'notes', memo: 'notes',
};

function rowsFromCsv(text: string) {
  const table = parseCsv(text);
  if (table.length < 2) return { rows: [], problems: ['The file has no data rows.'] };
  const headers = table[0].map((h) => HEADER_ALIASES[h.trim().toLowerCase()] ?? '');
  if (!headers.includes('amount')) return { rows: [], problems: ['The file needs an "amount" column.'] };

  const rows: Array<Record<string, unknown>> = [];
  const problems: string[] = [];
  table.slice(1).forEach((cells, index) => {
    const r: Record<string, string> = {};
    headers.forEach((key, i) => { if (key) r[key] = (cells[i] ?? '').trim(); });
    const amount = Number((r.amount || '').replace(/[$,\s]/g, ''));
    if (!Number.isFinite(amount) || amount <= 0) {
      problems.push(`Row ${index + 2}: amount is missing or not a number, skipped.`);
      return;
    }
    const kind = /^(expense|receipt|paid)/i.test(r.kind || '') ? 'EXPENSE' : 'BILL';
    rows.push({
      kind,
      vendor: r.vendor || null,
      invoiceNumber: r.invoiceNumber || null,
      amount,
      billDate: toIsoDate(r.billDate || ''),
      dueDate: toIsoDate(r.dueDate || ''),
      category: r.category || null,
      paid: /^(y|yes|true|1|paid)/i.test(r.paid || '') || kind === 'EXPENSE',
      paymentMethod: r.paymentMethod || null,
      notes: r.notes || null,
    });
  });
  return { rows, problems };
}

export default function BillsClient({
  initialReview,
  initialApproved,
}: {
  initialReview: BillRow[];
  initialApproved: BillRow[];
}) {
  const router = useRouter();
  const [review, setReview] = useState(initialReview);
  const [approved] = useState(initialApproved);
  const [kind, setKind] = useState<'BILL' | 'EXPENSE'>('BILL');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [rowError, setRowError] = useState<Record<string, string>>({});
  const [dragging, setDragging] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const csvInput = useRef<HTMLInputElement>(null);

  async function upload(files: FileList | File[]) {
    const list = Array.from(files);
    if (list.length === 0) return;
    setBusy(true);
    setMessage(null);
    const body = new FormData();
    list.forEach((f) => body.append('files', f));
    body.append('kind', kind);
    const res = await fetch('/api/bills/upload', { method: 'POST', body });
    const data = await res.json().catch(() => ({}));
    setBusy(false);
    if (fileInput.current) fileInput.current.value = '';
    const skipped: Array<{ name: string; reason: string }> = data.skipped || [];
    if (!res.ok && !data.created) {
      setMessage({ ok: false, text: skipped.map((s) => `${s.name}: ${s.reason}`).join(' · ') || 'Upload failed.' });
      return;
    }
    setMessage({
      ok: true,
      text: `${data.created} file(s) added below for review.` + (skipped.length ? ` Skipped: ${skipped.map((s) => `${s.name} (${s.reason})`).join(', ')}` : ''),
    });
    router.refresh();
    window.location.reload();
  }

  async function importCsv(file: File) {
    setBusy(true);
    setMessage(null);
    const { rows, problems } = rowsFromCsv(await file.text());
    if (rows.length === 0) {
      setBusy(false);
      setMessage({ ok: false, text: problems.join(' ') || 'Nothing to import.' });
      return;
    }
    const res = await fetch('/api/bills', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ rows }),
    });
    setBusy(false);
    if (csvInput.current) csvInput.current.value = '';
    if (!res.ok) {
      setMessage({ ok: false, text: 'The import failed. Check the file and try again.' });
      return;
    }
    const data = await res.json();
    setMessage({ ok: true, text: `${data.imported} row(s) imported for review.` + (problems.length ? ` ${problems.length} skipped.` : '') });
    window.location.reload();
  }

  function edit(id: string, patch: Partial<BillRow>) {
    setReview((rows) => rows.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  }

  async function save(row: BillRow) {
    const res = await fetch(`/api/bills/${row.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        kind: row.kind,
        vendor: row.vendor,
        invoiceNumber: row.invoiceNumber,
        amount: row.amount,
        billDate: row.billDate,
        dueDate: row.dueDate,
        category: row.category,
        paid: row.paid,
        paymentMethod: row.paymentMethod,
        notes: row.notes,
      }),
    });
    return res.ok;
  }

  async function approve(row: BillRow) {
    setRowError((e) => ({ ...e, [row.id]: '' }));
    if (!(await save(row))) {
      setRowError((e) => ({ ...e, [row.id]: 'Could not save your changes.' }));
      return;
    }
    const res = await fetch(`/api/bills/${row.id}/approve`, { method: 'POST' });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      setRowError((e) => ({ ...e, [row.id]: typeof data.error === 'string' ? data.error : 'Could not approve.' }));
      return;
    }
    setReview((rows) => rows.filter((r) => r.id !== row.id));
    router.refresh();
  }

  async function remove(row: BillRow) {
    if (!confirm('Delete this entry and its file?')) return;
    const res = await fetch(`/api/bills/${row.id}`, { method: 'DELETE' });
    if (res.ok) setReview((rows) => rows.filter((r) => r.id !== row.id));
  }

  function downloadTemplate() {
    const blob = new Blob([CSV_TEMPLATE], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'bills-template.csv';
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <div
          className={`card p-5 lg:col-span-2 border-2 border-dashed ${dragging ? 'border-blue-500 bg-blue-50' : 'border-slate-200'}`}
          onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => { e.preventDefault(); setDragging(false); upload(e.dataTransfer.files); }}
        >
          <h2 className="font-semibold text-slate-800">Upload bills or receipts</h2>
          <p className="text-sm text-slate-500 mt-1">
            Drop files here or choose them. PDFs, photos, CSV and Excel files up to 15 MB each. Each file becomes a row below where you fill in the amount and approve it.
          </p>
          <div className="flex flex-wrap items-center gap-3 mt-4">
            <select className="input max-w-[260px]" value={kind} onChange={(e) => setKind(e.target.value as 'BILL' | 'EXPENSE')}>
              <option value="BILL">These are bills I still owe</option>
              <option value="EXPENSE">These are already paid (receipts)</option>
            </select>
            <input ref={fileInput} type="file" multiple accept=".pdf,.png,.jpg,.jpeg,.webp,.heic,.csv,.txt,.xlsx,.xls" className="text-sm" disabled={busy} onChange={(e) => e.target.files && upload(e.target.files)} />
          </div>
        </div>

        <div className="card p-5">
          <h2 className="font-semibold text-slate-800">Import a list (CSV)</h2>
          <p className="text-sm text-slate-500 mt-1">
            For a spreadsheet of past bills and payments. In Excel use Save As → CSV. Columns: date, vendor, invoice, amount, due, type, category, paid, method, notes.
          </p>
          <div className="flex flex-wrap items-center gap-3 mt-4">
            <input ref={csvInput} type="file" accept=".csv" className="text-sm" disabled={busy} onChange={(e) => e.target.files?.[0] && importCsv(e.target.files[0])} />
          </div>
          <button type="button" className="text-blue-600 hover:text-blue-800 text-xs mt-3" onClick={downloadTemplate}>Download a sample CSV</button>
        </div>
      </div>

      {message && <p className={`text-sm ${message.ok ? 'text-green-700' : 'text-red-600'}`}>{message.text}</p>}

      <div>
        <h2 className="font-semibold text-slate-800 mb-2">To review ({review.length})</h2>
        {review.length === 0 ? (
          <div className="card p-6 text-sm text-slate-500">Nothing waiting. Upload a file or import a list above.</div>
        ) : (
          <div className="space-y-3">
            {review.map((r) => (
              <div key={r.id} className="card p-4">
                <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
                  <div className="text-sm">
                    {r.hasFile ? (
                      <a className="text-blue-600 hover:text-blue-800 font-medium" href={`/api/bills/${r.id}/file`}>{r.fileName}</a>
                    ) : (
                      <span className="font-medium text-slate-700">{r.source === 'CSV' ? 'From CSV import' : 'Entered by hand'}</span>
                    )}
                    <span className="text-slate-400 ml-2">{formatDate(r.createdAt)}</span>
                  </div>
                  <div className="flex gap-3">
                    <button className="btn-primary !py-1 !text-xs" onClick={() => approve(r)}>Approve</button>
                    <button className="text-red-500 hover:text-red-700 text-xs" onClick={() => remove(r)}>Delete</button>
                  </div>
                </div>
                {rowError[r.id] && <p className="text-xs text-red-600 mb-2">{rowError[r.id]}</p>}
                <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                  <div>
                    <label className="label">Type</label>
                    <select className="input" value={r.kind} onChange={(e) => edit(r.id, { kind: e.target.value, paid: e.target.value === 'EXPENSE' ? true : r.paid })}>
                      <option value="BILL">Bill (owed to supplier)</option>
                      <option value="EXPENSE">Expense (already paid)</option>
                    </select>
                  </div>
                  <div><label className="label">From (vendor) *</label><input className="input" value={r.vendor ?? ''} onChange={(e) => edit(r.id, { vendor: e.target.value })} /></div>
                  <div><label className="label">Invoice / receipt no.</label><input className="input" value={r.invoiceNumber ?? ''} onChange={(e) => edit(r.id, { invoiceNumber: e.target.value })} /></div>
                  <div><label className="label">Amount *</label><input type="number" step="0.01" min="0" className="input" value={r.amount ?? ''} onChange={(e) => edit(r.id, { amount: e.target.value === '' ? null : Number(e.target.value) })} /></div>
                  <div><label className="label">Bill date</label><input type="date" className="input" value={r.billDate ?? ''} onChange={(e) => edit(r.id, { billDate: e.target.value || null })} /></div>
                  {r.kind === 'BILL' ? (
                    <div><label className="label">Due date</label><input type="date" className="input" value={r.dueDate ?? ''} onChange={(e) => edit(r.id, { dueDate: e.target.value || null })} /></div>
                  ) : (
                    <div>
                      <label className="label">Category</label>
                      <select className="input" value={r.category ?? ''} onChange={(e) => edit(r.id, { category: e.target.value || null })}>
                        <option value="">Other</option>
                        {EXPENSE_CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
                      </select>
                    </div>
                  )}
                  <div>
                    <label className="label">Payment method</label>
                    <select className="input" value={r.paymentMethod ?? ''} onChange={(e) => edit(r.id, { paymentMethod: e.target.value || null })}>
                      <option value="">—</option>
                      {PAYMENT_METHODS.map((m) => <option key={m} value={m}>{m}</option>)}
                    </select>
                  </div>
                  <div className="flex items-end pb-2">
                    {r.kind === 'BILL' ? (
                      <label className="text-sm flex items-center gap-2"><input type="checkbox" checked={r.paid} onChange={(e) => edit(r.id, { paid: e.target.checked })} /> Already paid</label>
                    ) : (
                      <span className="text-xs text-slate-400">Counted as paid</span>
                    )}
                  </div>
                  <div className="col-span-2 md:col-span-4"><label className="label">Notes</label><input className="input" value={r.notes ?? ''} onChange={(e) => edit(r.id, { notes: e.target.value })} /></div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <div>
        <h2 className="font-semibold text-slate-800 mb-2">Recently approved</h2>
        <div className="card overflow-x-auto">
          <table className="table-base">
            <thead><tr><th>Added</th><th>From</th><th>Type</th><th>Invoice</th><th className="text-right">Amount</th><th>File</th></tr></thead>
            <tbody>
              {approved.map((a) => (
                <tr key={a.id}>
                  <td>{formatDate(a.createdAt)}</td>
                  <td className="font-medium">{a.vendor}</td>
                  <td>{a.kind === 'BILL' ? (a.paid ? 'Bill (paid)' : 'Bill') : 'Expense'}</td>
                  <td>{a.invoiceNumber || '—'}</td>
                  <td className="text-right">{money(a.amount)}</td>
                  <td>{a.hasFile ? <a className="text-blue-600 hover:text-blue-800 text-xs" href={`/api/bills/${a.id}/file`}>Download</a> : '—'}</td>
                </tr>
              ))}
              {approved.length === 0 && <tr><td colSpan={6} className="text-center text-slate-500 py-6">Nothing approved yet.</td></tr>}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
