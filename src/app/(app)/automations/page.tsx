import { prisma } from '@/lib/prisma';
import { requireModule } from '@/lib/session';
import PageHeader from '@/components/PageHeader';
import Badge from '@/components/Badge';
import AutomationsClient from './AutomationsClient';

/** Phase 13: the standardized-execution-contract admin view
 * (docs/AUTOMATION_SYSTEM.md) — every built-in scheduled job now runs
 * through AutomationJobRun, so a genuine failure (with its full error
 * message and stack trace) is always visible here, never only in
 * container logs. */
export default async function AutomationsPage() {
  await requireModule('automations');
  const rules = await prisma.automationRule.findMany({ orderBy: { createdAt: 'desc' } });
  const recentLogs = await prisma.automationLog.findMany({ orderBy: { createdAt: 'desc' }, take: 15 });
  const [recentRuns, failedRuns] = await Promise.all([
    prisma.automationJobRun.findMany({ orderBy: { createdAt: 'desc' }, take: 20 }),
    prisma.automationJobRun.findMany({ where: { status: 'FAILED' }, orderBy: { createdAt: 'desc' }, take: 20 }),
  ]);

  return (
    <div>
      <PageHeader
        title="Automations"
        subtitle="Built-in rules run automatically; add custom &quot;when X happens, do Y&quot; rules below"
      />
      <AutomationsClient initial={rules as never} />

      {failedRuns.length > 0 && (
        <div className="card p-5 mt-6 border-red-300 bg-red-50">
          <h2 className="font-semibold text-red-800 mb-3">Failed automation jobs ({failedRuns.length})</h2>
          <ul className="text-sm space-y-3">
            {failedRuns.map((r) => (
              <li key={r.id} className="border-b border-red-100 pb-2">
                <div className="flex items-center gap-2 flex-wrap">
                  <Badge label={r.status} />
                  <span className="font-medium">{r.jobKey}</span>
                  {r.entityType && r.entityId && <span className="text-xs text-slate-500">{r.entityType} {r.entityId}</span>}
                  <span className="text-xs text-slate-400">attempt {r.attempt}/{r.maxAttempts} · {r.createdAt.toLocaleString()}</span>
                </div>
                <p className="text-red-700 mt-1">{r.errorMessage}</p>
                {r.errorStack && (
                  <details className="mt-1">
                    <summary className="text-xs text-slate-500 cursor-pointer">Stack trace</summary>
                    <pre className="text-xs text-slate-600 whitespace-pre-wrap bg-white border border-slate-200 rounded p-2 mt-1">{r.errorStack}</pre>
                  </details>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="card p-5 mt-6">
        <h2 className="font-semibold text-slate-800 mb-3">Recent job runs</h2>
        <ul className="text-sm space-y-1">
          {recentRuns.map((r) => (
            <li key={r.id} className="flex items-center gap-2 flex-wrap">
              <Badge label={r.status} />
              <span>{r.jobKey}</span>
              <span className="text-xs text-slate-400">{r.trigger} · {r.createdAt.toLocaleString()}</span>
            </li>
          ))}
          {recentRuns.length === 0 && <p className="text-slate-400">No job runs recorded yet.</p>}
        </ul>
      </div>

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
