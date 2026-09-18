import Link from 'next/link';
import { prisma } from '@/lib/prisma';
import { requireModule } from '@/lib/session';
import PageHeader from '@/components/PageHeader';
import Badge from '@/components/Badge';
import { formatDate } from '@/lib/format';
import { Settings } from 'lucide-react';
import KnowledgeBaseSearch from './KnowledgeBaseSearch';

export default async function WordPressPage() {
  await requireModule('wordpress');
  const [articles, leads] = await Promise.all([
    prisma.knowledgeBaseArticle.findMany({ orderBy: { syncedAt: 'desc' }, take: 20 }),
    prisma.wordPressLead.findMany({ include: { contact: true, company: true }, orderBy: { submittedAt: 'desc' }, take: 20 }),
  ]);

  return (
    <div>
      <PageHeader
        title="WordPress"
        subtitle="Website knowledge base and inbound leads"
        actions={<Link href="/wordpress/settings" className="btn-secondary"><Settings size={16} /> Settings</Link>}
      />

      <div className="card p-5 mb-6">
        <h2 className="font-semibold text-slate-800 mb-3">Knowledge base search</h2>
        <KnowledgeBaseSearch />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="card p-5">
          <h2 className="font-semibold text-slate-800 mb-3">Recently synced content</h2>
          <ul className="text-sm divide-y divide-slate-100">
            {articles.map((a) => (
              <li key={a.id} className="py-2">
                <a href={a.url} target="_blank" rel="noreferrer" className="text-brand-700 hover:underline">{a.title}</a>
                <p className="text-xs text-slate-400">{a.type} · synced {formatDate(a.syncedAt)}</p>
              </li>
            ))}
            {articles.length === 0 && <p className="text-slate-400">No content synced yet.</p>}
          </ul>
        </div>

        <div className="card p-5">
          <h2 className="font-semibold text-slate-800 mb-3">Recent website leads</h2>
          <ul className="text-sm divide-y divide-slate-100">
            {leads.map((l) => (
              <li key={l.id} className="py-2">
                <div className="flex justify-between">
                  <span>{l.contact ? <Link href={`/contacts/${l.contact.id}`} className="text-brand-700 hover:underline">{l.contact.firstName} {l.contact.lastName}</Link> : 'Unknown contact'}</span>
                  <Badge label={l.consentGiven ? 'active' : 'inactive'} />
                </div>
                <p className="text-xs text-slate-400">{l.formName || 'Form'} · {formatDate(l.submittedAt)} {l.sourceUrl && `· ${l.sourceUrl}`}</p>
              </li>
            ))}
            {leads.length === 0 && <p className="text-slate-400">No leads captured yet.</p>}
          </ul>
        </div>
      </div>
    </div>
  );
}
