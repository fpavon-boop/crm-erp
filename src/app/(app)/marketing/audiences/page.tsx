import PageHeader from '@/components/PageHeader';
import Pagination from '@/components/Pagination';
import { formatDateTime } from '@/lib/format';
import { listAudiences } from '@/marketing/audiences/audience-service';
import { pageParam, requireMarketingViewer } from '@/marketing/http/page';
import { AudiencePreview, NewAudienceForm } from '@/marketing/ui/forms';

export default async function AudiencesPage({ searchParams }: { searchParams: { page?: string } }) {
  const { actor } = await requireMarketingViewer();
  const result = await listAudiences({ page: pageParam(searchParams.page) }, actor);

  return (
    <div>
      <PageHeader
        title="Audiences"
        subtitle="Rules over CRM contacts. Recipients and consent are resolved live, and no member lists are stored."
        actions={<NewAudienceForm />}
      />
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {result.items.map((a) => (
          <div key={a.id} className="card p-5">
            <div className="flex items-center justify-between gap-2">
              <h2 className="font-semibold text-slate-800">{a.name}</h2>
              <span className="badge bg-slate-100 text-slate-700">{a.channel}</span>
            </div>
            {a.description && <p className="text-sm text-slate-600 mt-1">{a.description}</p>}
            <pre className="text-xs bg-slate-50 border border-slate-200 rounded p-2 mt-3 whitespace-pre-wrap">{JSON.stringify(a.criteria, null, 2)}</pre>
            <p className="text-xs text-slate-500 mt-2">
              {a.lastSizeCount == null ? 'Not counted yet' : `${a.lastSizeCount} eligible at ${formatDateTime(a.lastComputedAt)}`}
            </p>
            <div className="mt-3">
              <AudiencePreview id={a.id} />
            </div>
          </div>
        ))}
        {result.items.length === 0 && <p className="text-sm text-slate-400">No audiences yet.</p>}
      </div>
      <Pagination page={result.page} total={result.total} pageSize={result.pageSize} basePath="/marketing/audiences" searchParams={{}} />
    </div>
  );
}
