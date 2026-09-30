'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { callMarketingApi, localInputToIso } from './client-api';

/** Date-time picker + button that sends `{ scheduledFor }` (schedule, reschedule, retry). */
export default function ScheduleControl({ url, method = 'POST', label }: { url: string; method?: 'POST' | 'PATCH'; label: string }) {
  const router = useRouter();
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const scheduledFor = localInputToIso(value);
    if (!scheduledFor) {
      setError('Pick a date and time.');
      return;
    }
    setBusy(true);
    setError(null);
    const res = await callMarketingApi(method, url, { scheduledFor });
    setBusy(false);
    if (!res.ok) return setError(res.error);
    setValue('');
    router.refresh();
  }

  return (
    <form onSubmit={submit} className="inline-flex flex-col gap-1">
      <span className="inline-flex gap-2">
        <input type="datetime-local" className="input py-1" value={value} onChange={(e) => setValue(e.target.value)} />
        <button className="btn-primary" disabled={busy}>
          {busy ? 'Working…' : label}
        </button>
      </span>
      {error && <span className="text-xs text-red-600 max-w-md">{error}</span>}
    </form>
  );
}
