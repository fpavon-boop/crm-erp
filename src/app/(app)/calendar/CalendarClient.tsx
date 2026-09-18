'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Trash2 } from 'lucide-react';

interface Event {
  id: string;
  title: string;
  description: string | null;
  startsAt: string;
  endsAt: string;
}

function groupByDay(events: Event[]) {
  const groups: Record<string, Event[]> = {};
  for (const e of events) {
    const key = new Date(e.startsAt).toDateString();
    groups[key] = groups[key] || [];
    groups[key].push(e);
  }
  return groups;
}

export default function CalendarClient({ initial }: { initial: Event[] }) {
  const router = useRouter();
  const [events, setEvents] = useState(initial);
  const [title, setTitle] = useState('');
  const [startsAt, setStartsAt] = useState('');
  const [endsAt, setEndsAt] = useState('');
  const [description, setDescription] = useState('');
  const [saving, setSaving] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!title || !startsAt || !endsAt) return;
    setSaving(true);
    const res = await fetch('/api/calendar', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title, description: description || null, startsAt, endsAt }),
    });
    const data = await res.json();
    setEvents((prev) => [...prev, data.event].sort((a, b) => +new Date(a.startsAt) - +new Date(b.startsAt)));
    setTitle('');
    setDescription('');
    setStartsAt('');
    setEndsAt('');
    setSaving(false);
    router.refresh();
  }

  async function remove(id: string) {
    setEvents((prev) => prev.filter((e) => e.id !== id));
    await fetch(`/api/calendar/${id}`, { method: 'DELETE' });
  }

  const groups = groupByDay(events);

  return (
    <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
      <div className="lg:col-span-1">
        <form onSubmit={submit} className="card p-5 space-y-3">
          <h2 className="font-semibold text-slate-800">New event</h2>
          <input className="input" placeholder="Title" value={title} onChange={(e) => setTitle(e.target.value)} />
          <div>
            <label className="label">Starts</label>
            <input type="datetime-local" className="input" value={startsAt} onChange={(e) => setStartsAt(e.target.value)} />
          </div>
          <div>
            <label className="label">Ends</label>
            <input type="datetime-local" className="input" value={endsAt} onChange={(e) => setEndsAt(e.target.value)} />
          </div>
          <textarea className="input" rows={2} placeholder="Description (optional)" value={description} onChange={(e) => setDescription(e.target.value)} />
          <button type="submit" disabled={saving} className="btn-primary w-full">{saving ? 'Saving...' : 'Add event'}</button>
        </form>
      </div>
      <div className="lg:col-span-2 space-y-4">
        {Object.entries(groups).map(([day, dayEvents]) => (
          <div key={day} className="card p-5">
            <h3 className="font-semibold text-slate-700 mb-2">{day}</h3>
            <ul className="text-sm space-y-2">
              {dayEvents.map((e) => (
                <li key={e.id} className="flex justify-between items-start border-b border-slate-100 pb-2">
                  <div>
                    <p className="font-medium">{e.title}</p>
                    <p className="text-xs text-slate-500">
                      {new Date(e.startsAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} - {new Date(e.endsAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                    </p>
                    {e.description && <p className="text-xs text-slate-500 mt-1">{e.description}</p>}
                  </div>
                  <button onClick={() => remove(e.id)} className="text-red-500 hover:text-red-700"><Trash2 size={14} /></button>
                </li>
              ))}
            </ul>
          </div>
        ))}
        {events.length === 0 && <p className="text-slate-400 text-sm">No upcoming events.</p>}
      </div>
    </div>
  );
}
