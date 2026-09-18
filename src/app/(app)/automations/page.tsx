import { prisma } from '@/lib/prisma';
import { requireModule } from '@/lib/session';
import PageHeader from '@/components/PageHeader';
import AutomationsClient from './AutomationsClient';

export default async function AutomationsPage() {
  await requireModule('automations');
  const rules = await prisma.automationRule.findMany({ orderBy: { createdAt: 'desc' } });
  const recentLogs = await prisma.automationLog.findMany({ orderBy: { createdAt: 'desc' }, take: 15 });

  return (
    <div>
      <PageHeader
        title="Automations"
        subtitle="Built-in rules run automatically; add custom &quot;when X happens, do Y&quot; rules below"
      />
      <AutomationsClient initial={rules as never} />
      <div className="card p-5 mt-6">
        <h2 className="font-semibold text-slate-800 mb-3">Recent activity</h2>
        <ul className="text-sm space-y-1">
          {recentLogs.map((l) => (
            <li key={l.id} className={l.success ? 'text-slate-600' : 'text-red-600'}>
              {l.createdAt.toLocaleString()} — {l.entityType} {l.entityId} — {l.message}
            </li>
          ))}
          {recentLogs.length === 0 && <p className="text-slate-400">No automation activity yet.</p>}
        </ul>
      </div>
    </div>
  );
}
