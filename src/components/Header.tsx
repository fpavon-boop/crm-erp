'use client';

import { signOut } from 'next-auth/react';
import { LogOut } from 'lucide-react';
import SearchBox from '@/components/SearchBox';

export default function Header({ name, role }: { name: string; role: string }) {
  return (
    <header className="h-16 shrink-0 bg-white border-b border-slate-200 flex items-center justify-between px-6 gap-4">
      <div className="flex-1 max-w-md">
        <SearchBox />
      </div>
      <div className="flex items-center gap-4">
        <div className="text-right">
          <div className="text-sm font-medium text-slate-800">{name}</div>
          <div className="text-xs text-slate-500">{role}</div>
        </div>
        <button
          onClick={() => signOut({ callbackUrl: '/login' })}
          className="btn-secondary !px-2 !py-2"
          title="Sign out"
        >
          <LogOut size={16} />
        </button>
      </div>
    </header>
  );
}
