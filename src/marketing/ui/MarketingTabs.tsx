'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import clsx from 'clsx';

const TABS = [
  { href: '/marketing/campaigns', label: 'Campaigns' },
  { href: '/marketing/posts', label: 'Social posts' },
  { href: '/marketing/videos', label: 'Videos' },
  { href: '/marketing/audiences', label: 'Audiences' },
  { href: '/marketing/accounts', label: 'Accounts' },
];

export default function MarketingTabs() {
  const pathname = usePathname();
  return (
    <nav className="flex gap-1 border-b border-slate-200 mb-6 overflow-x-auto">
      {TABS.map((t) => {
        const active = pathname === t.href || pathname?.startsWith(t.href + '/');
        return (
          <Link
            key={t.href}
            href={t.href}
            className={clsx(
              'px-4 py-2 text-sm font-medium whitespace-nowrap border-b-2 -mb-px',
              active ? 'border-brand-600 text-brand-700' : 'border-transparent text-slate-500 hover:text-slate-800'
            )}
          >
            {t.label}
          </Link>
        );
      })}
    </nav>
  );
}
