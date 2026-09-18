import Link from 'next/link';
import { requireModule } from '@/lib/session';
import PageHeader from '@/components/PageHeader';
import { Users, Mail, MessageCircle, Globe, ShieldCheck, Zap } from 'lucide-react';

const LINKS = [
  { href: '/settings/users', label: 'Users & Roles', description: 'Manage staff accounts and permissions', icon: Users },
  { href: '/inbox/accounts', label: 'Email Accounts', description: 'Connect mailboxes for the shared inbox', icon: Mail },
  { href: '/whatsapp/settings', label: 'WhatsApp Business', description: 'Configure the Meta Cloud API connection', icon: MessageCircle },
  { href: '/wordpress/settings', label: 'WordPress Integration', description: 'Connect your website and WooCommerce store', icon: Globe },
  { href: '/automations', label: 'Automation Rules', description: 'Configure "when X happens, do Y" rules', icon: Zap },
  { href: '/audit-log', label: 'Audit Log', description: 'Review all changes made in the system', icon: ShieldCheck },
];

export default async function SettingsPage() {
  await requireModule('settings');
  return (
    <div>
      <PageHeader title="Settings" />
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        {LINKS.map((link) => {
          const Icon = link.icon;
          return (
            <Link key={link.href} href={link.href} className="card p-5 hover:border-brand-400 transition-colors">
              <Icon size={20} className="text-brand-600 mb-2" />
              <h3 className="font-semibold text-slate-800">{link.label}</h3>
              <p className="text-sm text-slate-500 mt-1">{link.description}</p>
            </Link>
          );
        })}
      </div>
    </div>
  );
}
