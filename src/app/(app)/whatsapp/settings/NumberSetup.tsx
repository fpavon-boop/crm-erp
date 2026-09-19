'use client';

import { useState } from 'react';

export default function NumberSetup() {
  const [pin, setPin] = useState('');
  const [code, setCode] = useState('');
  const [result, setResult] = useState<string>('');
  const [busy, setBusy] = useState(false);

  async function call(body: Record<string, string>) {
    setBusy(true);
    setResult('Working...');
    const res = await fetch('/api/whatsapp/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    setResult(JSON.stringify(data, null, 2));
    setBusy(false);
  }

  return (
    <div className="card p-5">
      <h2 className="font-semibold text-slate-800 mb-1">Phone number setup</h2>
      <p className="text-xs text-slate-500 mb-3">
        Uses Meta&apos;s official API for the saved account and shows Meta&apos;s exact response. Order: check status,
        request a code, verify it, then register with a 6-digit PIN of your choice.
      </p>
      <div className="flex flex-wrap gap-2 items-end mb-2">
        <button className="btn-secondary" disabled={busy} onClick={() => call({ action: 'status' })}>Check status</button>
        <button className="btn-secondary" disabled={busy} onClick={() => call({ action: 'request_code', method: 'SMS' })}>Send code by text</button>
        <button className="btn-secondary" disabled={busy} onClick={() => call({ action: 'request_code', method: 'VOICE' })}>Send code by phone call</button>
      </div>
      <div className="flex flex-wrap gap-2 items-end mb-2">
        <input className="input max-w-[160px]" placeholder="Code received" value={code} onChange={(e) => setCode(e.target.value)} />
        <button className="btn-secondary" disabled={busy || !code} onClick={() => call({ action: 'verify_code', code })}>Verify code</button>
      </div>
      <div className="flex flex-wrap gap-2 items-end mb-3">
        <input className="input max-w-[160px]" type="password" inputMode="numeric" placeholder="6-digit PIN" value={pin} onChange={(e) => setPin(e.target.value)} />
        <button className="btn-primary" disabled={busy || pin.length !== 6} onClick={() => call({ action: 'register', pin })}>Register number</button>
      </div>
      {result && <pre className="text-xs bg-slate-50 border border-slate-200 rounded p-3 overflow-x-auto">{result}</pre>}
    </div>
  );
}
