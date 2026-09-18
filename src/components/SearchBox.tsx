'use client';

import { useState, useEffect, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { Search } from 'lucide-react';

interface Result {
  type: string;
  id: string;
  label: string;
  href: string;
}

export default function SearchBox() {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<Result[]>([]);
  const [open, setOpen] = useState(false);
  const router = useRouter();
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (query.trim().length < 2) {
      setResults([]);
      return;
    }
    const timeout = setTimeout(async () => {
      const res = await fetch(`/api/search?q=${encodeURIComponent(query)}`);
      if (res.ok) {
        const data = await res.json();
        setResults(data.results);
        setOpen(true);
      }
    }, 250);
    return () => clearTimeout(timeout);
  }, [query]);

  useEffect(() => {
    function onClick(e: MouseEvent) {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, []);

  return (
    <div ref={boxRef} className="relative">
      <div className="relative">
        <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
        <input
          className="input pl-9"
          placeholder="Search companies, contacts, invoices, orders..."
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onFocus={() => results.length > 0 && setOpen(true)}
        />
      </div>
      {open && results.length > 0 && (
        <div className="absolute mt-1 w-full bg-white border border-slate-200 rounded-md shadow-lg z-50 max-h-80 overflow-y-auto">
          {results.map((r) => (
            <button
              key={`${r.type}-${r.id}`}
              className="w-full text-left px-3 py-2 text-sm hover:bg-slate-50 flex items-center justify-between"
              onClick={() => {
                setOpen(false);
                setQuery('');
                router.push(r.href);
              }}
            >
              <span>{r.label}</span>
              <span className="text-xs text-slate-400 uppercase">{r.type}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
