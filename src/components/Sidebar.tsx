'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import clsx from 'clsx';
import {
  LayoutDashboard,
  Building2,
  Users,
  UserSquare2,
  Briefcase,
  FileText,
  Receipt,
  Truck,
  Boxes,
  CheckSquare,
  Calendar,
  Inbox,
  MessageCircle,
  Globe,
  Settings,
  Zap,
  ShieldCheck,
  type LucideIcon,
} from 'lucide-react';
import type { Module } from '@/lib/permissions';

interface NavItem {
  href: string;
  label: string;
  icon: LucideIcon;
  module: Module;
}

const NAV: NavItem[] = [
  { href: '/dashboard', label: 'Dashboard', icon: LayoutDashboard, module: 'dashboard' },
  { href: '/companies', label: 'Companies', icon: Building2, module: 'companies' },
  { href: '/contacts', label: 'Contacts', icon: UserSquare2, module: 'contacts' },
  { href: '/employees', label: 'Employees', icon: Users, module: 'employees' },
  { href: '/sales/pipeline', label: 'Sales Pipeline', icon: Briefcase, module: 'sales' },
  { href: '/sales/quotes', label: 'Quotes', icon: FileText, module: 'sales' },
  { href: '/sales/orders', label: 'Sales Orders', icon: FileText, module: 'sales' },
  { href: '/invoicing', label: 'Invoicing', icon: Receipt, module: 'invoicing' },
  { href: '/purchasing', label: 'Purchasing', icon: Truck, module: 'purchasing' },
  { href: '/inventory', label: 'Inventory', icon: Boxes, module: 'inventory' },
  { href: '/tasks', label: 'Tasks', icon: CheckSquare, module: 'tasks' },
  { href: '/calendar', label: 'Calendar', icon: Calendar, module: 'calendar' },
  { href: '/inbox', label: 'Email Inbox', icon: Inbox, module: 'inbox' },
  { href: '/whatsapp', label: 'WhatsApp', icon: MessageCircle, module: 'whatsapp' },
  { href: '/wordpress', label: 'WordPress', icon: Globe, module: 'wordpress' },
  { href: '/automations', label: 'Automations', icon: Zap, module: 'automations' },
  { href: '/audit-log', label: 'Audit Log', icon: ShieldCheck, module: 'settings' },
  { href: '/settings', label: 'Settings', icon: Settings, module: 'settings' },
];

export default function Sidebar({ allowedModules }: { allowedModules: Module[] }) {
  const pathname = usePathname();

  return (
    <aside className="hidden md:flex md:flex-col w-64 shrink-0 bg-slate-900 text-slate-200 min-h-screen">
      <div className="px-5 py-5 text-lg font-bold text-white border-b border-slate-800">
        CRM / ERP
      </div>
      <nav className="flex-1 overflow-y-auto py-3">
        {NAV.filter((item) => allowedModules.includes(item.module)).map((item) => {
          const Icon = item.icon;
          const active = pathname === item.href || pathname?.startsWith(item.href + '/');
          return (
            <Link
              key={item.href}
              href={item.href}
              className={clsx(
                'flex items-center gap-3 px-5 py-2.5 text-sm font-medium transition-colors',
                active
                  ? 'bg-slate-800 text-white border-r-2 border-brand-500'
                  : 'text-slate-400 hover:text-white hover:bg-slate-800/60'
              )}
            >
              <Icon size={17} />
              {item.label}
            </Link>
          );
        })}
      </nav>
    </aside>
  );
}
