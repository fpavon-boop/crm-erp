'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import type { TemplateChannel, TemplateKey } from '@/lib/communications/templates';

export interface SendCommunicationTemplateOption {
  key: TemplateKey;
  label: string;
  channels: TemplateChannel[];
  subject: string | null;
  body: string;
}

export interface SendCommunicationLinkTarget {
  relatedType: string;
  relatedId: string;
}

/**
 * The "draft, review, edit, then send" form behind every template in
 * Phase 10 (docs/CUSTOMER_COMMUNICATION.md). Picking a template swaps in
 * its already-rendered draft (no network round trip — every template was
 * rendered server-side for this record); everything after that is a plain
 * editable field. Nothing sends until the human clicks Send — there is no
 * auto-send path here.
 */
export default function SendCommunicationForm({
  templates,
  defaultEmail,
  defaultPhone,
  companyId,
  contactId,
  linkTarget,
}: {
  templates: SendCommunicationTemplateOption[];
  defaultEmail?: string | null;
  defaultPhone?: string | null;
  companyId?: string | null;
  contactId?: string | null;
  linkTarget?: SendCommunicationLinkTarget | null;
}) {
  const router = useRouter();
  const first = templates[0];
  const [templateKey, setTemplateKey] = useState<TemplateKey | ''>(first?.key ?? '');
  const [channel, setChannel] = useState<'email' | 'whatsapp'>(first?.channels[0] ?? 'email');
  const [to, setTo] = useState(defaultEmail || '');
  const [subject, setSubject] = useState(first?.subject ?? '');
  const [body, setBody] = useState(first?.body ?? '');
  const [sending, setSending] = useState(false);
  const [result, setResult] = useState<{ sent: boolean; reason?: string } | null>(null);

  const selected = templates.find((t) => t.key === templateKey);
  const availableChannels = selected?.channels ?? ['email'];

  function applyTemplate(key: TemplateKey) {
    const t = templates.find((tpl) => tpl.key === key);
    if (!t) return;
    setTemplateKey(key);
    setSubject(t.subject ?? '');
    setBody(t.body);
    const nextChannel = t.channels.includes(channel) ? channel : t.channels[0];
    setChannel(nextChannel);
    setTo(nextChannel === 'email' ? defaultEmail || '' : defaultPhone || '');
  }

  function changeChannel(next: 'email' | 'whatsapp') {
    setChannel(next);
    setTo(next === 'email' ? defaultEmail || '' : defaultPhone || '');
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!to.trim() || !body.trim()) return;
    setSending(true);
    setResult(null);
    try {
      const res = await fetch('/api/communications/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          channel,
          to,
          subject: channel === 'email' ? subject : undefined,
          body,
          templateKey: templateKey || undefined,
          companyId: companyId || undefined,
          contactId: contactId || undefined,
          relatedType: linkTarget?.relatedType,
          relatedId: linkTarget?.relatedId,
        }),
      });
      const data = await res.json();
      setResult({ sent: !!data.sent, reason: data.reason });
      if (data.sent) router.refresh();
    } finally {
      setSending(false);
    }
  }

  if (templates.length === 0) return null;

  return (
    <form onSubmit={submit} className="space-y-3 mb-4 border-b border-slate-100 pb-4">
      <div className="flex flex-wrap gap-3">
        <div className="flex-1 min-w-[200px]">
          <label className="block text-xs text-slate-500 mb-1">Template</label>
          <select className="input w-full" value={templateKey} onChange={(e) => applyTemplate(e.target.value as TemplateKey)}>
            {templates.map((t) => (
              <option key={t.key} value={t.key}>{t.label}</option>
            ))}
          </select>
        </div>
        <div>
          <label className="block text-xs text-slate-500 mb-1">Channel</label>
          <select className="input" value={channel} onChange={(e) => changeChannel(e.target.value as 'email' | 'whatsapp')}>
            {availableChannels.includes('email') && <option value="email">Email</option>}
            {availableChannels.includes('whatsapp') && <option value="whatsapp">WhatsApp</option>}
          </select>
        </div>
        <div className="flex-1 min-w-[200px]">
          <label className="block text-xs text-slate-500 mb-1">{channel === 'email' ? 'To (email)' : 'To (phone)'}</label>
          <input className="input w-full" value={to} onChange={(e) => setTo(e.target.value)} placeholder={channel === 'email' ? 'customer@example.com' : '+1 555 123 4567'} />
        </div>
      </div>

      {channel === 'email' && (
        <div>
          <label className="block text-xs text-slate-500 mb-1">Subject</label>
          <input className="input w-full" value={subject} onChange={(e) => setSubject(e.target.value)} />
        </div>
      )}

      <div>
        <label className="block text-xs text-slate-500 mb-1">Message — review and edit before sending</label>
        <textarea className="input w-full" rows={5} value={body} onChange={(e) => setBody(e.target.value)} />
      </div>

      {channel === 'whatsapp' && (
        <p className="text-xs text-amber-600">
          Free-form WhatsApp messages can only be delivered within Meta&apos;s 24-hour customer service window
          (i.e. the customer has messaged in the last 24 hours). See docs/CUSTOMER_COMMUNICATION.md.
        </p>
      )}

      <div className="flex items-center gap-3">
        <button type="submit" className="btn-primary" disabled={sending || !to.trim() || !body.trim()}>
          {sending ? 'Sending...' : 'Send'}
        </button>
        {result && (
          <span className={result.sent ? 'text-green-600 text-sm' : 'text-red-600 text-sm'}>
            {result.sent ? 'Sent and logged.' : `Not sent: ${result.reason || 'unknown error'}`}
          </span>
        )}
      </div>
    </form>
  );
}
