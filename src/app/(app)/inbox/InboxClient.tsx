'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import Badge from '@/components/Badge';
import { formatDateTime } from '@/lib/format';

interface Message {
  id: string;
  direction: string;
  fromAddress: string;
  toAddresses: string;
  subject: string | null;
  bodyText: string | null;
  receivedAt: string;
  isRead: boolean;
  isAnswered: boolean;
  company?: { id: string; name: string } | null;
  contact?: { id: string; firstName: string; lastName: string } | null;
}

export default function InboxClient({ initial }: { initial: Message[] }) {
  const [messages, setMessages] = useState(initial);
  const [selectedId, setSelectedId] = useState<string | null>(initial[0]?.id || null);
  const [thread, setThread] = useState<Message[]>([]);
  const [replyBody, setReplyBody] = useState('');
  const [sending, setSending] = useState(false);
  const [suggesting, setSuggesting] = useState(false);
  const [syncing, setSyncing] = useState(false);

  const selected = messages.find((m) => m.id === selectedId) || null;

  useEffect(() => {
    if (!selectedId) return;
    fetch(`/api/email-messages/${selectedId}`)
      .then((r) => r.json())
      .then((d) => {
        setThread(d.thread || []);
        setMessages((prev) => prev.map((m) => (m.id === selectedId ? { ...m, isRead: true } : m)));
      });
  }, [selectedId]);

  async function suggestReply() {
    if (!selectedId) return;
    setSuggesting(true);
    const res = await fetch(`/api/email-messages/${selectedId}/suggest-reply`, { method: 'POST' });
    const data = await res.json();
    setReplyBody(data.draft || '');
    setSuggesting(false);
  }

  async function sendReply() {
    if (!selectedId || !replyBody.trim()) return;
    setSending(true);
    const res = await fetch(`/api/email-messages/${selectedId}/reply`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ body: replyBody }),
    });
    setSending(false);
    if (res.ok) {
      setReplyBody('');
      setMessages((prev) => prev.map((m) => (m.id === selectedId ? { ...m, isAnswered: true } : m)));
    }
  }

  async function syncAll() {
    setSyncing(true);
    const accountsRes = await fetch('/api/email-accounts');
    const { accounts } = await accountsRes.json();
    for (const acc of accounts || []) {
      await fetch(`/api/email-accounts/${acc.id}/sync`, { method: 'POST' }).catch(() => undefined);
    }
    const res = await fetch('/api/email-messages');
    const data = await res.json();
    setMessages(data.messages || []);
    setSyncing(false);
  }

  return (
    <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
      <div className="card p-0 overflow-hidden lg:col-span-1">
        <div className="p-3 border-b border-slate-100 flex justify-between items-center">
          <span className="text-sm font-medium">Inbox</span>
          <button className="text-xs text-brand-700 hover:underline" onClick={syncAll} disabled={syncing}>
            {syncing ? 'Syncing...' : 'Sync now'}
          </button>
        </div>
        <ul className="max-h-[70vh] overflow-y-auto divide-y divide-slate-100">
          {messages.map((m) => (
            <li
              key={m.id}
              onClick={() => setSelectedId(m.id)}
              className={`p-3 cursor-pointer hover:bg-slate-50 ${selectedId === m.id ? 'bg-brand-50' : ''} ${!m.isRead ? 'font-semibold' : ''}`}
            >
              <div className="flex justify-between text-xs text-slate-400">
                <span>{m.direction === 'INBOUND' ? m.fromAddress : m.toAddresses}</span>
                <span>{formatDateTime(m.receivedAt)}</span>
              </div>
              <p className="text-sm truncate">{m.subject || '(no subject)'}</p>
              <div className="flex gap-1 mt-1">
                {m.company && <span className="text-xs text-brand-600">{m.company.name}</span>}
                {!m.isAnswered && m.direction === 'INBOUND' && <Badge label="PENDING" />}
              </div>
            </li>
          ))}
          {messages.length === 0 && <li className="p-4 text-sm text-slate-400">No emails yet. Connect an account in Settings.</li>}
        </ul>
      </div>

      <div className="lg:col-span-2 card p-5">
        {selected ? (
          <div>
            <div className="flex justify-between items-start mb-3">
              <div>
                <h2 className="font-semibold text-lg">{selected.subject || '(no subject)'}</h2>
                <p className="text-sm text-slate-500">
                  {selected.company && <Link href={`/companies/${selected.company.id}`} className="text-brand-700 hover:underline">{selected.company.name}</Link>}
                  {selected.contact && <> · <Link href={`/contacts/${selected.contact.id}`} className="text-brand-700 hover:underline">{selected.contact.firstName} {selected.contact.lastName}</Link></>}
                  {!selected.company && !selected.contact && <span className="text-amber-600">Not linked to a contact/company</span>}
                </p>
              </div>
            </div>

            <div className="space-y-4 max-h-72 overflow-y-auto border border-slate-100 rounded-md p-3 mb-4">
              {thread.map((m) => (
                <div key={m.id} className={`text-sm ${m.direction === 'OUTBOUND' ? 'text-right' : ''}`}>
                  <p className="text-xs text-slate-400">{m.direction} · {formatDateTime(m.receivedAt)}</p>
                  <p className="whitespace-pre-wrap">{m.bodyText}</p>
                </div>
              ))}
            </div>

            <div>
              <div className="flex justify-between items-center mb-1">
                <label className="label !mb-0">Reply</label>
                <button className="text-xs text-brand-700 hover:underline" onClick={suggestReply} disabled={suggesting}>
                  {suggesting ? 'Drafting...' : 'Suggest reply from knowledge base'}
                </button>
              </div>
              <textarea className="input" rows={5} value={replyBody} onChange={(e) => setReplyBody(e.target.value)} placeholder="Write your reply — review before sending." />
              <button className="btn-primary mt-2" onClick={sendReply} disabled={sending || !replyBody.trim()}>
                {sending ? 'Sending...' : 'Send reply'}
              </button>
            </div>
          </div>
        ) : (
          <p className="text-slate-400">Select an email to view it.</p>
        )}
      </div>
    </div>
  );
}
