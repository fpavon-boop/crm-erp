import Link from 'next/link';
import PageHeader from '@/components/PageHeader';
import Pagination from '@/components/Pagination';
import { formatDate } from '@/lib/format';
import { listCampaigns } from '@/marketing/campaigns/service';
import { pageParam, requireMarketingViewer } from '@/marketing/http/page';
import StatusBadge from '@/marketing/ui/StatusBadge';
import { CHANNELS, NewCampaignForm } from '@/marketing/ui/forms';

const STATUSES = ['DRAFT', 'AI_GENERATED', 'HUMAN_REVIEW', 'APPROVED', 'REJECTED', 'SCHEDULED', 'PUBLISHED', 'FAILED'];

export default async function CampaignsPage({ searchParams }: { searchParams: { status?: string; channel?: string; search?: string; page?: string } }) {
  const { actor } = await requireMarketingViewer();
  const status = STATUSES.includes(searchParams.status ?? '') ? searchParams.status : undefined;
  const channel = (CHANNELS as readonly string[]).includes(searchParams.channel ?? '') ? searchParams.channel : undefined;
  const search = searchParams.search?.trim() || undefined;
  const page = pageParam(searchParams.page);
  const result = await listCampaigns({ status: status as never, channel: channel as never, search, page }, actor);

  return (
    <div>
      <PageHeader title="Marketing campaigns" subtitle={`${result.total} campaign${result.total === 1 ? '' : 's'}`} actions={<NewCampaignForm />} />

      <form className="flex flex-wrap gap-2 mb-4" method="get">
        <input name="search" defaultValue={search} placeholder="Search name…" className="input max-w-xs" />
        <select name="status" defaultValue={status ?? ''} className="input max-w-[12rem]">
          <option value="">All statuses</option>
          {STATUSES.map((s) => (
            <option key={s} value={s}>{s.replace(/_/g, ' ')}</option>
          ))}
        </select>
        <select name="channel" defaultValue={channel ?? ''} className="input max-w-[12rem]">
          <option value="">All channels</option>
          {CHANNELS.map((c) => (
            <option key={c} value={c}>{c}</option>
          ))}
        </select>
        <button className="btn-secondary">Filter</button>
      </form>

      <div className="card overflow-x-auto">
        <table className="table-base">
          <thead>
            <tr>
              <th>Name</th>
              <th>Status</th>
              <th>Channels</th>
              <th>Dates</th>
              <th>Updated</th>
            </tr>
          </thead>
          <tbody>
            {result.items.map((c) => (
              <tr key={c.id}>
                <td>
                  <Link href={`/marketing/campaigns/${c.id}`} className="font-medium text-brand-700 hover:underline">
                    {c.name}
                  </Link>
                  {c.objective && <p className="text-xs text-slate-500 truncate max-w-md">{c.objective}</p>}
                </td>
                <td><StatusBadge label={c.status} /></td>
                <td className="text-xs text-slate-600">{c.channels.join(', ') || '—'}</td>
                <td className="text-xs text-slate-600">{c.startsAt ? `${formatDate(c.startsAt)} → ${formatDate(c.endsAt)}` : '—'}</td>
                <td className="text-xs text-slate-500">{formatDate(c.updatedAt)}</td>
              </tr>
            ))}
            {result.items.length === 0 && (
              <tr>
                <td colSpan={5} className="text-center text-slate-400 py-8">No campaigns yet.</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <Pagination page={result.page} total={result.total} pageSize={result.pageSize} basePath="/marketing/campaigns" searchParams={{ status, channel, search }} />
    </div>
  );
}
