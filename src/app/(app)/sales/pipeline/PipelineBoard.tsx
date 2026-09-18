'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { money } from '@/lib/format';

interface Opportunity {
  id: string;
  title: string;
  value: string | number;
  stage: string;
  company?: { id: string; name: string } | null;
  contact?: { id: string; firstName: string; lastName: string } | null;
}

const STAGES: { key: string; label: string; color: string }[] = [
  { key: 'NEW', label: 'New', color: 'bg-slate-100' },
  { key: 'QUALIFIED', label: 'Qualified', color: 'bg-blue-50' },
  { key: 'PROPOSAL', label: 'Proposal', color: 'bg-indigo-50' },
  { key: 'NEGOTIATION', label: 'Negotiation', color: 'bg-amber-50' },
  { key: 'WON', label: 'Won', color: 'bg-green-50' },
  { key: 'LOST', label: 'Lost', color: 'bg-red-50' },
];

export default function PipelineBoard({ initial }: { initial: Opportunity[] }) {
  const [opportunities, setOpportunities] = useState(initial);
  const router = useRouter();

  useEffect(() => setOpportunities(initial), [initial]);

  async function moveStage(id: string, stage: string) {
    setOpportunities((prev) => prev.map((o) => (o.id === id ? { ...o, stage } : o)));
    await fetch(`/api/opportunities/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ stage }),
    });
    router.refresh();
  }

  function onDrop(e: React.DragEvent, stage: string) {
    const id = e.dataTransfer.getData('text/plain');
    if (id) moveStage(id, stage);
  }

  return (
    <div className="flex gap-4 overflow-x-auto pb-4">
      {STAGES.map((stage) => {
        const items = opportunities.filter((o) => o.stage === stage.key);
        const total = items.reduce((s, o) => s + Number(o.value), 0);
        return (
          <div
            key={stage.key}
            className={`w-72 shrink-0 rounded-lg ${stage.color} p-3`}
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => onDrop(e, stage.key)}
          >
            <div className="flex items-center justify-between mb-3 px-1">
              <h3 className="font-semibold text-slate-700 text-sm">{stage.label}</h3>
              <span className="text-xs text-slate-500">{items.length} · {money(total)}</span>
            </div>
            <div className="space-y-2">
              {items.map((o) => (
                <div
                  key={o.id}
                  draggable
                  onDragStart={(e) => e.dataTransfer.setData('text/plain', o.id)}
                  className="bg-white rounded-md border border-slate-200 p-3 shadow-sm cursor-move"
                >
                  <p className="text-sm font-medium text-slate-800">{o.title}</p>
                  {o.company && (
                    <Link href={`/companies/${o.company.id}`} className="text-xs text-brand-700 hover:underline">
                      {o.company.name}
                    </Link>
                  )}
                  <p className="text-xs text-slate-500 mt-1">{money(o.value)}</p>
                </div>
              ))}
              {items.length === 0 && <p className="text-xs text-slate-400 px-1">No opportunities</p>}
            </div>
          </div>
        );
      })}
    </div>
  );
}
