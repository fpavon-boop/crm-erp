'use client';

import { useRef, useState } from 'react';
import type { SyncResponse, SyncIssue } from '@/lib/inventory/price-sync';

interface ErrorResponse {
  error?: string;
  errors?: SyncIssue[];
}

function Stat({ label, value, tone = 'default' }: { label: string; value: number; tone?: 'default' | 'warn' | 'good' }) {
  const color = tone === 'warn' ? 'text-amber-700' : tone === 'good' ? 'text-green-700' : 'text-slate-900';
  return (
    <div className="card p-4">
      <div className={`text-2xl font-semibold ${color}`}>{value}</div>
      <div className="text-xs text-slate-500 mt-1">{label}</div>
    </div>
  );
}

const show = (v: string | number | boolean | null) => (v === null || v === '' ? '—' : String(v));

export default function SyncPricesClient() {
  const fileRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [mirrorCore, setMirrorCore] = useState(true);
  const [busy, setBusy] = useState<'preview' | 'apply' | null>(null);
  const [preview, setPreview] = useState<SyncResponse | null>(null);
  const [applied, setApplied] = useState<SyncResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fileErrors, setFileErrors] = useState<SyncIssue[]>([]);

  function reset() {
    setPreview(null);
    setApplied(null);
    setError(null);
    setFileErrors([]);
  }

  async function send(apply: boolean) {
    if (!file) return;
    setBusy(apply ? 'apply' : 'preview');
    setError(null);
    setFileErrors([]);
    try {
      const form = new FormData();
      form.append('file', file);
      form.append('mirrorCore', String(mirrorCore));
      form.append('apply', String(apply));
      if (apply && preview) form.append('expectedHash', preview.fileHash);

      const res = await fetch('/api/inventory/sync-prices', { method: 'POST', body: form });
      const data = (await res.json().catch(() => ({}))) as SyncResponse & ErrorResponse;
      if (!res.ok) {
        if (data.errors?.length) setFileErrors(data.errors);
        setError(data.error || (data.errors?.length ? 'The file has errors — nothing was synced.' : 'Something went wrong.'));
        if (!apply) setPreview(null);
        return;
      }
      if (apply) {
        setApplied(data);
        setPreview(null);
      } else {
        setPreview(data);
        setApplied(null);
      }
    } catch {
      setError('Could not reach the server.');
    } finally {
      setBusy(null);
    }
  }

  function confirmApply() {
    if (!preview) return;
    const s = preview.summary;
    const msg = `Apply to the live database?\n\n${s.create} new, ${s.update} changed${s.mirrorEnabled ? `, ${s.mirrorUpdates} core product updates` : ''}.`;
    if (window.confirm(msg)) void send(true);
  }

  const result = applied ?? preview;
  const nothingToDo = preview ? preview.summary.create + preview.summary.update + preview.summary.mirrorUpdates === 0 : true;

  return (
    <div className="space-y-4">
      <div className="card p-4 space-y-3">
        <div>
          <label className="label">Price list (.xlsx)</label>
          <input
            ref={fileRef}
            type="file"
            accept=".xlsx"
            className="input max-w-md"
            onChange={(e) => {
              setFile(e.target.files?.[0] ?? null);
              reset();
            }}
          />
          <p className="text-xs text-slate-500 mt-1">
            Reads the &quot;Price List&quot; sheet (and the &quot;WooCommerce Products&quot; sheet for dimensions and a price cross-check). Nothing is written until you press Apply.
          </p>
        </div>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={mirrorCore}
            onChange={(e) => {
              setMirrorCore(e.target.checked);
              reset();
            }}
          />
          Also update retail price and cost on matching products (same SKU) used by quotes and invoices
        </label>
        <button type="button" className="btn-primary" disabled={!file || busy !== null} onClick={() => send(false)}>
          {busy === 'preview' ? 'Checking…' : 'Preview changes (dry run)'}
        </button>
      </div>

      {error && (
        <div className="card p-4 border-red-300 bg-red-50 text-sm text-red-800">
          <p className="font-medium">{error}</p>
          {fileErrors.length > 0 && (
            <ul className="mt-2 list-disc pl-5 space-y-0.5">
              {fileErrors.slice(0, 50).map((e, i) => (
                <li key={i}>
                  {e.row ? `Row ${e.row}` : 'File'}
                  {e.partNo ? ` [${e.partNo}]` : ''}: {e.message}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {applied && (
        <div className="card p-4 border-green-300 bg-green-50 text-sm text-green-900">
          <p className="font-medium">Applied.</p>
          <p>
            {applied.summary.create} products created, {applied.summary.update} updated, {applied.summary.unchanged} unchanged
            {applied.summary.mirrorEnabled ? `, ${applied.summary.mirrorUpdates} core products updated` : ''}.
          </p>
        </div>
      )}

      {result && (
        <>
          <div className="grid grid-cols-2 md:grid-cols-6 gap-3">
            <Stat label={applied ? 'Created' : 'New'} value={result.summary.create} tone="good" />
            <Stat label={applied ? 'Updated' : 'Changed'} value={result.summary.update} tone="good" />
            <Stat label="Unchanged" value={result.summary.unchanged} />
            <Stat label="Core product updates" value={result.summary.mirrorUpdates} />
            <Stat label="Estimated costs" value={result.summary.estimatedCost} tone="warn" />
            <Stat label="Warnings" value={result.warnings.length} tone={result.warnings.length ? 'warn' : 'default'} />
          </div>

          <p className="text-xs text-slate-600">
            {result.summary.rows} products in the file · {result.summary.fixedRetail} with a fixed retail price ·{' '}
            {result.summary.ltl} ship LTL freight. {result.summary.estimatedCost} costs are estimates (retail ÷ markup): they are flagged
            and are never copied onto core product costs.
            {result.truncated && ' Lists below are capped at 300 rows.'}
          </p>

          {result.changed.length > 0 && (
            <details className="card p-4" open={result.changed.length <= 40}>
              <summary className="cursor-pointer font-medium text-sm">Changed products ({result.summary.update})</summary>
              <div className="overflow-x-auto mt-3">
                <table className="table-base">
                  <thead><tr><th>PartNo</th><th>Name</th><th>What changes</th></tr></thead>
                  <tbody>
                    {result.changed.map((c) => (
                      <tr key={c.partNo}>
                        <td className="font-mono text-xs">{c.partNo}</td>
                        <td>{c.name}</td>
                        <td className="text-xs">{c.diffs.map((d) => `${d.field}: ${show(d.from)} → ${show(d.to)}`).join(' · ') || 'recalculated margins'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </details>
          )}

          {result.created.length > 0 && (
            <details className="card p-4" open={result.created.length <= 40}>
              <summary className="cursor-pointer font-medium text-sm">New products ({result.summary.create})</summary>
              <div className="overflow-x-auto mt-3">
                <table className="table-base">
                  <thead><tr><th>PartNo</th><th>Name</th><th>Group</th><th>Cost</th><th>Retail</th></tr></thead>
                  <tbody>
                    {result.created.map((c) => (
                      <tr key={c.partNo}>
                        <td className="font-mono text-xs">{c.partNo}</td>
                        <td>{c.name}</td>
                        <td>{c.categoryGroup}</td>
                        <td>{c.cost.toFixed(2)}{c.estimated ? ' (est.)' : ''}</td>
                        <td>{c.retail.toFixed(2)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </details>
          )}

          {result.mirror.length > 0 && (
            <details className="card p-4">
              <summary className="cursor-pointer font-medium text-sm">Core products that will be updated ({result.summary.mirrorUpdates})</summary>
              <div className="overflow-x-auto mt-3">
                <table className="table-base">
                  <thead><tr><th>SKU</th><th>Name</th><th>Price</th><th>Cost</th></tr></thead>
                  <tbody>
                    {result.mirror.map((m) => (
                      <tr key={m.sku}>
                        <td className="font-mono text-xs">{m.sku}</td>
                        <td>{m.name}</td>
                        <td>{m.price.from.toFixed(2)} → {m.price.to.toFixed(2)}</td>
                        <td>{m.cost ? `${m.cost.from.toFixed(2)} → ${m.cost.to.toFixed(2)}` : 'unchanged'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </details>
          )}

          {result.warnings.length > 0 && (
            <details className="card p-4">
              <summary className="cursor-pointer font-medium text-sm text-amber-800">Warnings ({result.warnings.length})</summary>
              <ul className="mt-3 list-disc pl-5 text-xs space-y-0.5">
                {result.warnings.map((w, i) => (
                  <li key={i}>{w.partNo ? `[${w.partNo}] ` : ''}{w.message}</li>
                ))}
              </ul>
            </details>
          )}

          {(result.summary.missingInFile > 0 || result.wooOnly.length > 0) && (
            <details className="card p-4">
              <summary className="cursor-pointer font-medium text-sm">
                Not synced ({result.summary.missingInFile} in the catalog but not in the file · {result.wooOnly.length} WooCommerce products not in the price list)
              </summary>
              <div className="mt-3 text-xs space-y-3">
                {result.missingInFile.length > 0 && (
                  <div>
                    <p className="font-medium">In the catalog but not in this file (left untouched):</p>
                    <ul className="list-disc pl-5">{result.missingInFile.map((m) => <li key={m.partNo}>{m.partNo} — {m.productName}</li>)}</ul>
                  </div>
                )}
                {result.wooOnly.length > 0 && (
                  <div>
                    <p className="font-medium">In WooCommerce but not in the price list (not imported):</p>
                    <ul className="list-disc pl-5">{result.wooOnly.map((w, i) => <li key={i}>{w.sku || (w.id ? `ID ${w.id}` : '—')} — {w.name}</li>)}</ul>
                  </div>
                )}
              </div>
            </details>
          )}

          {preview && (
            <div className="card p-4 flex items-center gap-3">
              <button type="button" className="btn-primary" disabled={busy !== null || nothingToDo} onClick={confirmApply}>
                {busy === 'apply' ? 'Applying…' : 'Apply these changes'}
              </button>
              {nothingToDo && <span className="text-sm text-slate-500">Everything is already up to date.</span>}
            </div>
          )}
        </>
      )}
    </div>
  );
}
