import Link from 'next/link';
import PageHeader from '@/components/PageHeader';
import Pagination from '@/components/Pagination';
import { formatDate } from '@/lib/format';
import { listCampaigns } from '@/marketing/campaigns/service';
import { listVideoProjects } from '@/marketing/videos/video-service';
import { pageParam, requireMarketingViewer } from '@/marketing/http/page';
import StatusBadge from '@/marketing/ui/StatusBadge';
import { NewVideoForm } from '@/marketing/ui/forms';

export default async function VideosPage({ searchParams }: { searchParams: { page?: string } }) {
  const { actor } = await requireMarketingViewer();
  const page = pageParam(searchParams.page);
  const [videos, campaigns] = await Promise.all([listVideoProjects({ page }, actor), listCampaigns({ pageSize: 100 }, actor)]);
  const campaignName = new Map(campaigns.items.map((c) => [c.id, c.name]));

  return (
    <div>
      <PageHeader
        title="Video projects"
        subtitle={`${videos.total} project${videos.total === 1 ? '' : 's'} · rendering runs in n8n`}
        actions={<NewVideoForm campaigns={campaigns.items.filter((c) => c.status !== 'PUBLISHED').map((c) => ({ id: c.id, label: c.name }))} />}
      />
      <div className="card overflow-x-auto">
        <table className="table-base">
          <thead>
            <tr>
              <th>Title</th>
              <th>Phase</th>
              <th>Platform</th>
              <th>Campaign</th>
              <th>Updated</th>
            </tr>
          </thead>
          <tbody>
            {videos.items.map((v) => (
              <tr key={v.id}>
                <td>
                  <Link href={`/marketing/videos/${v.id}`} className="font-medium text-brand-700 hover:underline">{v.title}</Link>
                  <span className="text-xs text-slate-400 ml-2">{v.language} · {v.aspectRatio}</span>
                </td>
                <td><StatusBadge label={v.phase} /></td>
                <td className="text-xs">{v.platform.replace(/_/g, ' ')}</td>
                <td className="text-xs">{v.campaignId ? (
                  <Link href={`/marketing/campaigns/${v.campaignId}`} className="hover:underline">{campaignName.get(v.campaignId) ?? v.campaignId}</Link>
                ) : '—'}</td>
                <td className="text-xs text-slate-500">{formatDate(v.updatedAt)}</td>
              </tr>
            ))}
            {videos.items.length === 0 && (
              <tr>
                <td colSpan={5} className="text-center text-slate-400 py-8">No video projects.</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <Pagination page={videos.page} total={videos.total} pageSize={videos.pageSize} basePath="/marketing/videos" searchParams={{}} />
    </div>
  );
}
