'use client';

import { useState } from 'react';
import Link from 'next/link';
import Badge from '@/components/Badge';
import { formatDateTime } from '@/lib/format';

interface Message {
  id: string;
  direction: string;
  fromNumber: string;
  toNumber: string;
  body: string | null;
  templateName: string | null;
  status: string;
  timestamp: string;
  contact?: { id: string; firstName: string; lastName: string } | null;
  company?: { id: string; name: string } | null;
}

interface Conversation {
  key: string;
  number: string;
  contact?: { id: string; firstName: string; lastName: string } | null;
  company?: { id: string; name: string } | null;
  messages: Message[];
}

interface Template { id: string; name: string; language: string }

export default function WhatsAppClient({ conversations, templates }: { conversations: Conversation[]; templates: Template[] }) {
  const [selectedKey, setSelectedKey] = useState(conversations[0]?.key || null);
  const [mode, setMode] = useState<'text' | 'template'>('text');
  const [text, setText] = useState('');
  const [templateName, setTemplateName] = useState(templates[0]?.name || '');
  const [sending, setSending] = useState(false);

  const selected = conversations.find((c) => c.key === selectedKey) || null;

  async function send() {
    if (!selected) return;
    setSending(true);
    await fetch('/api/whatsapp/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(
        mode === 'text'
          ? { mode: 'text', to: selected.number, body: text }
          : { mode: 'template', to: selected.number, templateName }
      ),
    });
    setSending(false);
    setText('');
  }

  return (
    <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
      <div className="card p-0 overflow-hidden">
        <div className="p-3 border-b border-slate-100 text-sm font-medium">Conversations</div>
        <ul className="max-h-[70vh] overflow-y-auto divide-y divide-slate-100">
          {conversations.map((c) => (
            <li key={c.key} onClick={() => setSelectedKey(c.key)} className={`p-3 cursor-pointer hover:bg-slate-50 ${selectedKey === c.key ? 'bg-brand-50' : ''}`}>
              <p className="text-sm font-medium">
                {c.contact ? `${c.contact.firstName} ${c.contact.lastName}` : c.number}
              </p>
              <p className="text-xs text-slate-400 truncate">{c.messages[c.messages.length - 1]?.body || c.messages[c.messages.length - 1]?.templateName}</p>
            </li>
          ))}
          {conversations.length === 0 && <li className="p-4 text-sm text-slate-400">No WhatsApp conversations yet.</li>}
        </ul>
      </div>

      <div className="lg:col-span-2 card p-5">
        {selected ? (
          <div>
            <div className="mb-3">
              <h2 className="font-semibold">
                {selected.contact ? (
                  <Link href={`/contacts/${selected.contact.id}`} className="text-brand-700 hover:underline">{selected.contact.firstName} {selected.contact.lastName}</Link>
                ) : selected.number}
              </h2>
              {selected.company && <Link href={`/companies/${selected.company.id}`} className="text-xs text-brand-600 hover:underline">{selected.company.name}</Link>}
            </div>

            <div className="space-y-2 max-h-80 overflow-y-auto border border-slate-100 rounded-md p-3 mb-4">
              {selected.messages.map((m) => (
                <div key={m.id} className={`text-sm ${m.direction === 'OUTBOUND' ? 'text-right' : ''}`}>
                  <div className={`inline-block px-3 py-2 rounded-lg max-w-[80%] ${m.direction === 'OUTBOUND' ? 'bg-brand-600 text-white' : 'bg-slate-100'}`}>
                    {m.body || `[template: ${m.templateName}]`}
                  </div>
                  <p className="text-xs text-slate-400">{formatDateTime(m.timestamp)} · <Badge label={m.status} /></p>
                </div>
              ))}
            </div>

            <div className="flex gap-2 mb-2">
              <button className={`text-xs px-2 py-1 rounded ${mode === 'text' ? 'bg-brand-600 text-white' : 'bg-slate-100'}`} onClick={() => setMode('text')}>Free text (within 24h window)</button>
              <button className={`text-xs px-2 py-1 rounded ${mode === 'template' ? 'bg-brand-600 text-white' : 'bg-slate-100'}`} onClick={() => setMode('template')}>Approved template</button>
            </div>

            {mode === 'text' ? (
              <textarea className="input" rows={3} value={text} onChange={(e) => setText(e.target.value)} placeholder="Message..." />
            ) : (
              <select className="input" value={templateName} onChange={(e) => setTemplateName(e.target.value)}>
                {templates.map((t) => <option key={t.id} value={t.name}>{t.name}</option>)}
                {templates.length === 0 && <option value="">No templates configured</option>}
              </select>
            )}
            <button className="btn-primary mt-2" onClick={send} disabled={sending || (mode === 'text' ? !text.trim() : !templateName)}>
              {sending ? 'Sending...' : 'Send'}
            </button>
          </div>
        ) : (
          <p className="text-slate-400">Select a conversation.</p>
        )}
      </div>
    </div>
  );
}
