import PageHeader from '@/components/PageHeader';
import Pagination from '@/components/Pagination';
import { prisma } from '@/lib/prisma';
import { formatDateTime } from '@/lib/format';
import { listCampaigns } from '@/marketing/campaigns/service';
import { listSocialPosts } from '@/marketing/publishing/post-service';
import { listSocialAccounts } from '@/marketing/publishing/social-accounts';
import { pageParam, requireMarketingViewer } from '@/marketing/http/page';
import StatusBadge from '@/marketing/ui/StatusBadge';
import ApiButton from '@/marketing/ui/ApiButton';
import ScheduleControl from '@/marketing/ui/ScheduleControl';
import TransitionButtons from '@/marketing/ui/TransitionButtons';
import { NewPostForm } from '@/marketing/ui/forms';

const STATUSES = ['DRAFT', 'HUMAN_REVIEW', 'APPROVED', 'REJECTED', 'SCHEDULED', 'PUBLISHED', 'FAILED'];

export default async function PostsPage({ searchParams }: { searchParams: { status?: string; campaignId?: string; page?: string } }) {
  const { actor, isAdmin } = await requireMarketingViewer();
  const status = STATUSES.includes(searchParams.status ?? '') ? searchParams.status : undefined;
  const campaignId = searchParams.campaignId || undefined;
  const page = pageParam(searchParams.page);

  const [posts, accounts, campaigns] = await Promise.all([
    listSocialPosts({ status: status as never, campaignId, page }, actor),
    listSocialAccounts({}, actor),
    listCampaigns({ pageSize: 100 }, actor),
  ]);
  // Editable campaigns' content, for the "new post" picker (marketing table, read-only here).
  const openCampaigns = campaigns.items.filter((c) => c.status !== 'PUBLISHED');
  const contents = await prisma.marketingContent.findMany({
    where: { campaignId: { in: openCampaigns.map((c) => c.id) } },
    select: { id: true, campaignId: true, channel: true, language: true, title: true, type: true },
    orderBy: [{ channel: 'asc' }, { language: 'asc' }],
  });
  const accountLabel = new Map(accounts.map((a) => [a.id, `${a.platform} · ${a.handle || a.displayName || a.externalAccountId}`]));
  const campaignName = new Map(campaigns.items.map((c) => [c.id, c.name]));

  return (
    <div>
      <PageHeader
        title="Social posts"
        subtitle={`${posts.total} post${posts.total === 1 ? '' : 's'}${campaignId ? ` · ${campaignName.get(campaignId) ?? 'campaign'}` : ''}`}
        actions={
          <NewPostForm
            accounts={accounts.filter((a) => a.status === 'ACTIVE').map((a) => ({ id: a.id, label: accountLabel.get(a.id)! }))}
            campaigns={openCampaigns.map((c) => ({ id: c.id, label: c.name }))}
            contents={contents.map((c) => ({ id: c.id, campaignId: c.campaignId, label: `${c.channel} ${c.language.toUpperCase()} · ${c.title || c.type}` }))}
          />
        }
      />

      <form className="flex flex-wrap gap-2 mb-4" method="get">
        {campaignId && <input type="hidden" name="campaignId" value={campaignId} />}
        <select name="status" defaultValue={status ?? ''} className="input max-w-[12rem]">
          <option value="">All statuses</option>
          {STATUSES.map((s) => (
            <option key={s} value={s}>{s.replace(/_/g, ' ')}</option>
          ))}
        </select>
        <button className="btn-secondary">Filter</button>
      </form>

      <div className="card overflow-x-auto">
        <table className="table-base">
          <thead>
            <tr>
              <th>Post</th>
              <th>Phase</th>
              <th>Account</th>
              <th>When</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {posts.items.map((p) => (
              <tr key={p.id} className="align-top">
                <td className="max-w-sm">
                  <p className="text-xs text-slate-500">{p.campaignId ? campaignName.get(p.campaignId) ?? p.campaignId : '—'} · {p.language} · v{p.version}</p>
                  <p className="whitespace-pre-wrap line-clamp-3">{p.caption || '(caption from content)'}</p>
                  {p.errorMessage && <p className="text-xs text-red-700 mt-1">{p.errorMessage}</p>}
                  {p.permalink && (
                    <a href={p.permalink} target="_blank" rel="noopener noreferrer" className="text-xs text-brand-700 hover:underline">View live post</a>
                  )}
                </td>
                <td><StatusBadge label={p.phase} /></td>
                <td className="text-xs">{accountLabel.get(p.socialAccountId) ?? p.socialAccountId}</td>
                <td className="text-xs text-slate-600">
                  {p.publishedAt ? `Published ${formatDateTime(p.publishedAt)}` : p.scheduledFor ? formatDateTime(p.scheduledFor) : '—'}
                </td>
                <td>
                  <div className="flex flex-col gap-2">
                    <TransitionButtons
                      status={p.status}
                      role={actor.role}
                      url={`/api/marketing/posts/${p.id}/transition`}
                      targets={['HUMAN_REVIEW', 'APPROVED', 'REJECTED', 'DRAFT']}
                      reviewAlias="REVIEW"
                    />
                    {isAdmin && p.phase === 'APPROVED' && <ScheduleControl url={`/api/marketing/posts/${p.id}/schedule`} label="Schedule" />}
                    {isAdmin && p.phase === 'SCHEDULED' && (
                      <>
                        <ScheduleControl url={`/api/marketing/posts/${p.id}/schedule`} method="PATCH" label="Reschedule" />
                        <ApiButton label="Unschedule" method="DELETE" url={`/api/marketing/posts/${p.id}/schedule`} confirmText="Cancel this scheduled post?" />
                      </>
                    )}
                    {isAdmin && p.phase === 'FAILED' && <ScheduleControl url={`/api/marketing/posts/${p.id}/retry`} label="Retry" />}
                  </div>
                </td>
              </tr>
            ))}
            {posts.items.length === 0 && (
              <tr>
                <td colSpan={5} className="text-center text-slate-400 py-8">No posts.</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <Pagination page={posts.page} total={posts.total} pageSize={posts.pageSize} basePath="/marketing/posts" searchParams={{ status, campaignId }} />
      {isAdmin && (
        <div className="mt-6 flex items-center gap-3 text-sm text-slate-500">
          <ApiButton label="Run dispatcher now" url="/api/marketing/posts/dispatch" confirmText="Dispatch every due post and render now?" />
          <span>Normally triggered by the signed n8n schedule.</span>
        </div>
      )}
    </div>
  );
}
