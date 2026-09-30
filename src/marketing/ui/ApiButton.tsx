'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { callMarketingApi } from './client-api';

/**
 * One-click marketing action (transition, render, delete…). Optionally asks
 * for confirmation and/or a reviewer comment, then refreshes the server
 * page — or navigates to `redirectTo` — on success. Errors render inline.
 */
export default function ApiButton({
  label,
  url,
  method = 'POST',
  body,
  confirmText,
  askComment,
  variant = 'secondary',
  redirectTo,
}: {
  label: string;
  url: string;
  method?: 'POST' | 'PATCH' | 'DELETE';
  body?: Record<string, unknown>;
  confirmText?: string;
  /** Prompt for an optional comment, sent as `comment`. `'required'` refuses an empty one. */
  askComment?: boolean | 'required';
  variant?: 'primary' | 'secondary' | 'danger';
  redirectTo?: string;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run() {
    setError(null);
    if (confirmText && !window.confirm(confirmText)) return;
    let payload = body;
    if (askComment) {
      const comment = window.prompt(askComment === 'required' ? 'Reason (required):' : 'Comment (optional):') ?? null;
      if (comment === null) return;
      if (askComment === 'required' && !comment.trim()) {
        setError('A reason is required.');
        return;
      }
      if (comment.trim()) payload = { ...(payload ?? {}), comment: comment.trim() };
    }
    setBusy(true);
    const res = await callMarketingApi(method, url, payload);
    setBusy(false);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    if (redirectTo) router.push(redirectTo);
    router.refresh();
  }

  return (
    <span className="inline-flex flex-col items-start gap-1">
      <button type="button" className={`btn-${variant}`} disabled={busy} onClick={run}>
        {busy ? 'Working…' : label}
      </button>
      {error && <span className="text-xs text-red-600 max-w-md">{error}</span>}
    </span>
  );
}
