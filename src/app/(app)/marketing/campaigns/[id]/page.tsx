import Link from 'next/link';
import PageHeader from '@/components/PageHeader';
import { formatDate, formatDateTime, money, toNumber } from '@/lib/format';
import { getCampaign, getCampaignSafeguards } from '@/marketing/campaigns/service';
import { listSocialPosts } from '@/marketing/publishing/post-service';
import { listVideoProjects } from '@/marketing/videos/video-service';
import { createAnalyticsService } from '@/marketing/analytics/service';
import { orNotFound, requireMarketingViewer } from '@/marketing/http/page';
import StatusBadge from '@/marketing/ui/StatusBadge';
import ApiButton from '@/marketing/ui/ApiButton';
import TransitionButtons from '@/marketing/ui/TransitionButtons';
import { ContentEditor } from '@/marketing/ui/forms';

const DAY = 86_400_000;

/** Settled-or-null: a failing side panel (analytics, safeguards) must not take down the page. */
async function settle<T>(p: Promise<T>): Promise<T | null> {
  try {
    return await p;
  } catch (err) {
    console.error('[marketing-ui] panel failed:', err);
    return null;
  }
}

interface Finding {
  severity?: string;
  message?: string;
}

function complianceOf(value: unknown): { verdict: string | null; findings: Finding[] } {
  const v = (value ?? {}) as { verdict?: string; findings?: Finding[]; issues?: Finding[] };
  return { verdict: v.verdict ?? null, findings: Array.isArray(v.findings) ? v.findings : Array.isArray(v.issues) ? v.issues : [] };
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-xs text-slate-500">{label}</p>
      <p className="text-lg font-semibold text-slate-900 tabular-nums">{value}</p>
    </div>
  );
}

const pct = (v: number | null) => (v == null ? '—' : `${(v * 100).toFixed(1)}%`);

export default async function CampaignDetailPage({ params }: { params: { id: string } }) {
  const { actor } = await requireMarketingViewer();
  const campaign = await orNotFound(getCampaign(params.id, actor));
  const now = new Date();
  const [safeguards, posts, videos, performance] = await Promise.all([
    settle(getCampaignSafeguards(campaign.id, actor)),
    listSocialPosts({ campaignId: campaign.id, pageSize: 50 }, actor),
    listVideoProjects({ campaignId: campaign.id, pageSize: 50 }, actor),
    settle(createAnalyticsService().getCampaignPerformance(campaign.id, { from: new Date(now.getTime() - 30 * DAY), to: now })),
  ]);
  const locked = campaign.status === 'SCHEDULED' || campaign.status === 'PUBLISHED';
  const neverReviewed = campaign.status === 'DRAFT' && campaign.approvals.length === 0;

  return (
    <div className="space-y-6">
      <PageHeader
        title={campaign.name}
        subtitle={campaign.objective ?? undefined}
        actions={
          <>
            <StatusBadge label={campaign.status} />
            {neverReviewed && (
              <ApiButton label="Delete draft" method="DELETE" url={`/api/marketing/campaigns/${campaign.id}`} variant="danger" confirmText="Delete this draft campaign?" redirectTo="/marketing/campaigns" />
            )}
          </>
        }
      />

      <div className="card p-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <dl className="grid grid-cols-2 sm:grid-cols-4 gap-x-8 gap-y-3 text-sm">
            <div><dt className="text-slate-500">Channels</dt><dd>{campaign.channels.join(', ') || '—'}</dd></div>
            <div><dt className="text-slate-500">Dates</dt><dd>{campaign.startsAt ? `${formatDate(campaign.startsAt)} → ${formatDate(campaign.endsAt)}` : '—'}</dd></div>
            <div><dt className="text-slate-500">Discount</dt><dd>{campaign.discountPct == null ? '—' : `${toNumber(campaign.discountPct)}%`}</dd></div>
            <div><dt className="text-slate-500">Budget</dt><dd>{campaign.budget == null ? '—' : money(campaign.budget)}</dd></div>
            <div><dt className="text-slate-500">Products</dt><dd className="text-xs break-all">{campaign.productIds.join(', ') || '—'}</dd></div>
            <div><dt className="text-slate-500">Approved</dt><dd>{campaign.approvedAt ? formatDateTime(campaign.approvedAt) : '—'}</dd></div>
          </dl>
          <TransitionButtons
            status={campaign.status}
            role={actor.role}
            url={`/api/marketing/campaigns/${campaign.id}/transition`}
            targets={['HUMAN_REVIEW', 'APPROVED', 'REJECTED', 'SCHEDULED', 'PUBLISHED', 'DRAFT']}
            warnVerdict={safeguards?.verdict === 'WARN'}
          />
        </div>
        {campaign.description && <p className="text-sm text-slate-700 mt-4 whitespace-pre-wrap">{campaign.description}</p>}
      </div>

      <div className="card p-5">
        <div className="flex items-center gap-2 mb-3">
          <h2 className="font-semibold text-slate-800">Stock &amp; margin safeguards (live)</h2>
          {safeguards && <StatusBadge label={safeguards.verdict} />}
        </div>
        {!safeguards && <p className="text-sm text-slate-400">Safeguards could not be evaluated right now.</p>}
        {safeguards && (
          <div className="text-sm space-y-2">
            {safeguards.issues.map((i, n) => (
              <p key={n} className={i.severity === 'BLOCK' ? 'text-red-700' : 'text-amber-700'}>{i.message}</p>
            ))}
            {safeguards.products.map((p) => (
              <div key={p.productId} className="border-t border-slate-100 pt-2">
                <p className="text-xs text-slate-500">
                  Product {p.productId} · on hand {p.inventory.onHand} · list {p.margin.listPrice == null ? '—' : money(p.margin.listPrice)} · promo {p.margin.promoPrice == null ? '—' : money(p.margin.promoPrice)}
                </p>
                {[...p.inventory.issues, ...p.margin.issues].map((i, n) => (
                  <p key={n} className={i.severity === 'BLOCK' ? 'text-red-700' : 'text-amber-700'}>{i.message}</p>
                ))}
              </div>
            ))}
            {safeguards.verdict === 'PASS' && <p className="text-green-700">All checks pass.</p>}
          </div>
        )}
      </div>

      <div className="card p-5">
        <h2 className="font-semibold text-slate-800 mb-3">Content ({campaign.contents.length})</h2>
        <div className="space-y-4">
          {campaign.contents.map((c) => {
            const comp = complianceOf(c.compliance);
            return (
              <div key={c.id} className="border border-slate-200 rounded-md p-4">
                <div className="flex flex-wrap items-center gap-2 mb-2 text-xs">
                  <StatusBadge label={c.status} />
                  <span className="font-medium text-slate-700">{c.channel} · {c.type.replace(/_/g, ' ')}</span>
                  <span className="text-slate-500 uppercase">{c.language}</span>
                  <span className="text-slate-400">v{c.version}{c.aiGenerated ? ' · AI' : ' · human-edited'}</span>
                  {comp.verdict && <StatusBadge label={comp.verdict} />}
                </div>
                <ContentEditor id={c.id} title={c.title} body={c.body} hashtags={c.hashtags} locked={locked || c.status === 'PUBLISHED'} />
                {comp.findings.length > 0 && (
                  <ul className="mt-2 text-xs space-y-0.5">
                    {comp.findings.map((f, n) => (
                      <li key={n} className={f.severity === 'BLOCK' ? 'text-red-700' : 'text-amber-700'}>{f.message}</li>
                    ))}
                  </ul>
                )}
                {c.rejectionReason && <p className="text-xs text-red-700 mt-2">Rejected: {c.rejectionReason}</p>}
              </div>
            );
          })}
          {campaign.contents.length === 0 && <p className="text-sm text-slate-400">No content yet.</p>}
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="card p-5">
          <h2 className="font-semibold text-slate-800 mb-3">Social posts ({posts.total})</h2>
          <ul className="text-sm space-y-2">
            {posts.items.map((p) => (
              <li key={p.id} className="flex items-center gap-2 flex-wrap">
                <StatusBadge label={p.phase} />
                <span className="truncate max-w-xs">{p.caption || '(no caption)'}</span>
                <span className="text-xs text-slate-400">{p.scheduledFor ? formatDateTime(p.scheduledFor) : ''}</span>
              </li>
            ))}
            {posts.items.length === 0 && <p className="text-slate-400">None.</p>}
          </ul>
          <Link href={`/marketing/posts?campaignId=${campaign.id}`} className="text-xs text-brand-700 hover:underline mt-3 inline-block">Manage posts →</Link>
        </div>
        <div className="card p-5">
          <h2 className="font-semibold text-slate-800 mb-3">Videos ({videos.total})</h2>
          <ul className="text-sm space-y-2">
            {videos.items.map((v) => (
              <li key={v.id} className="flex items-center gap-2">
                <StatusBadge label={v.phase} />
                <Link href={`/marketing/videos/${v.id}`} className="text-brand-700 hover:underline">{v.title}</Link>
                <span className="text-xs text-slate-400">{v.platform.replace(/_/g, ' ')}</span>
              </li>
            ))}
            {videos.items.length === 0 && <p className="text-slate-400">None.</p>}
          </ul>
        </div>
      </div>

      <div className="card p-5">
        <h2 className="font-semibold text-slate-800 mb-1">Performance (last 30 days)</h2>
        <p className="text-xs text-slate-500 mb-4">Platform metrics from n8n snapshots. Revenue is derived from realised CRM orders — an estimate, not finance data.</p>
        {!performance && <p className="text-sm text-slate-400">Analytics unavailable.</p>}
        {performance && (
          <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-8 gap-4">
            <Stat label="Impressions" value={performance.totals.impressions.toLocaleString()} />
            <Stat label="Reach" value={performance.totals.reach.toLocaleString()} />
            <Stat label="Clicks" value={performance.totals.clicks.toLocaleString()} />
            <Stat label="CTR" value={pct(performance.rates.ctr)} />
            <Stat label="Engagement" value={pct(performance.rates.engagementRate)} />
            <Stat label="Conversions" value={performance.totals.conversions.toLocaleString()} />
            <Stat label="Attributed revenue" value={performance.attribution ? money(performance.attribution.revenue) : '—'} />
            <Stat label="ROAS" value={performance.rates.roas == null ? '—' : `${performance.rates.roas.toFixed(2)}×`} />
          </div>
        )}
      </div>

      <div className="card p-5">
        <h2 className="font-semibold text-slate-800 mb-3">Approval history</h2>
        <ul className="text-sm space-y-2">
          {campaign.approvals.map((a) => (
            <li key={a.id} className="flex flex-wrap items-center gap-2">
              <span className="text-xs text-slate-400">{formatDateTime(a.createdAt)}</span>
              <span className="text-xs text-slate-500">{a.targetType}</span>
              <StatusBadge label={a.fromStatus} />→<StatusBadge label={a.toStatus} />
              {a.safeguardVerdict && <StatusBadge label={a.safeguardVerdict} />}
              {a.warningsAcknowledged && <span className="text-xs text-amber-700">warnings acknowledged</span>}
              {a.comment && <span className="text-slate-600">“{a.comment}”</span>}
            </li>
          ))}
          {campaign.approvals.length === 0 && <p className="text-slate-400">No decisions yet.</p>}
        </ul>
      </div>
    </div>
  );
}
