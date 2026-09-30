import PageHeader from '@/components/PageHeader';
import { formatDate } from '@/lib/format';
import { listSocialAccounts } from '@/marketing/publishing/social-accounts';
import { requireMarketingViewer } from '@/marketing/http/page';
import StatusBadge from '@/marketing/ui/StatusBadge';
import ApiButton from '@/marketing/ui/ApiButton';
import { NewAccountForm } from '@/marketing/ui/forms';

export default async function AccountsPage() {
  const { actor, isAdmin } = await requireMarketingViewer();
  const accounts = await listSocialAccounts({}, actor);

  return (
    <div>
      <PageHeader
        title="Social accounts"
        subtitle="Publishing targets. Platform tokens are stored in n8n, never in the CRM."
        actions={isAdmin ? <NewAccountForm /> : undefined}
      />
      <div className="card overflow-x-auto">
        <table className="table-base">
          <thead>
            <tr>
              <th>Platform</th>
              <th>Account</th>
              <th>n8n credential</th>
              <th>Status</th>
              <th>Added</th>
              {isAdmin && <th />}
            </tr>
          </thead>
          <tbody>
            {accounts.map((a) => (
              <tr key={a.id}>
                <td>{a.platform}</td>
                <td>
                  <p className="font-medium">{a.displayName || a.handle || a.externalAccountId}</p>
                  <p className="text-xs text-slate-500">{a.handle ? `@${a.handle.replace(/^@/, '')} · ` : ''}{a.externalAccountId}</p>
                </td>
                <td className="text-xs">{a.n8nCredentialRef || '—'}</td>
                <td><StatusBadge label={a.status} /></td>
                <td className="text-xs text-slate-500">{formatDate(a.createdAt)}</td>
                {isAdmin && (
                  <td>
                    {a.status === 'ACTIVE' ? (
                      <ApiButton label="Disconnect" method="PATCH" url={`/api/marketing/social-accounts/${a.id}`} body={{ status: 'DISCONNECTED' }} confirmText="Stop publishing to this account?" />
                    ) : (
                      <ApiButton label="Reactivate" method="PATCH" url={`/api/marketing/social-accounts/${a.id}`} body={{ status: 'ACTIVE' }} />
                    )}
                  </td>
                )}
              </tr>
            ))}
            {accounts.length === 0 && (
              <tr>
                <td colSpan={isAdmin ? 6 : 5} className="text-center text-slate-400 py-8">No accounts registered.</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
