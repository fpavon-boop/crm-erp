'use client';

import { useState } from 'react';

interface Article { id: string; title: string; url: string; excerpt: string | null; type: string }

export default function KnowledgeBaseSearch() {
  const [q, setQ] = useState('');
  const [results, setResults] = useState<Article[]>([]);
  const [loading, setLoading] = useState(false);

  async function search(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    const res = await fetch(`/api/wordpress/knowledge-base?q=${encodeURIComponent(q)}`);
    const data = await res.json();
    setResults(data.articles || []);
    setLoading(false);
  }

  return (
    <div>
      <form onSubmit={search} className="flex gap-2 mb-3">
        <input className="input" placeholder="Search synced pages, posts, FAQs, services..." value={q} onChange={(e) => setQ(e.target.value)} />
        <button className="btn-secondary shrink-0" disabled={loading}>{loading ? 'Searching...' : 'Search'}</button>
      </form>
      <ul className="text-sm space-y-2">
        {results.map((a) => (
          <li key={a.id} className="border-b border-slate-100 pb-2">
            <a href={a.url} target="_blank" rel="noreferrer" className="text-brand-700 hover:underline font-medium">{a.title}</a>
            <span className="text-xs text-slate-400 ml-2">{a.type}</span>
            {a.excerpt && <p className="text-slate-500 text-xs mt-0.5">{a.excerpt.slice(0, 160)}</p>}
          </li>
        ))}
      </ul>
    </div>
  );
}
