import { prisma } from '@/lib/prisma';
import { requireModule } from '@/lib/session';
import PageHeader from '@/components/PageHeader';
import { formatDateTime } from '@/lib/format';
import { Download } from 'lucide-react';

export default async function AuditLogPage() {
  await requireModule('settings');
  const logs = await prisma.auditLog.findMany({
    include: { user: true, company: true },
    orderBy: { createdAt: 'desc' },
    take: 200,
  });

  return (
    <div>
      <PageHeader
        title="Audit Log"
        subtitle={`${logs.length} recent events`}
        actions={<a href="/api/audit-log?format=csv" className="btn-secondary"><Download size={16} /> Export CSV</a>}
      />
      <div className="card overflow-x-auto">
        <table className="table-base">
          <thead><tr><th>Date</th><th>User</th><th>Action</th><th>Entity</th><th>Company</th></tr></thead>
          <tbody>
            {logs.map((l) => (
              <tr key={l.id}>
                <td>{formatDateTime(l.createdAt)}</td>
                <td>{l.user?.name || 'System'}</td>
                <td>{l.action}</td>
                <td>{l.entityType} <span className="text-xs text-slate-400">{l.entityId.slice(0, 8)}</span></td>
                <td>{l.company?.name || '—'}</td>
              </tr>
            ))}
            {logs.length === 0 && <tr><td colSpan={5} className="text-center text-slate-500 py-8">No audit events yet.</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}
