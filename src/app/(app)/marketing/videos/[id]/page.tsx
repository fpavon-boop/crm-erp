import Link from 'next/link';
import PageHeader from '@/components/PageHeader';
import { formatDateTime, toNumber } from '@/lib/format';
import { getVideoProject } from '@/marketing/videos/video-service';
import { orNotFound, requireMarketingViewer } from '@/marketing/http/page';
import StatusBadge from '@/marketing/ui/StatusBadge';
import ApiButton from '@/marketing/ui/ApiButton';
import TransitionButtons from '@/marketing/ui/TransitionButtons';
import { AddSceneForm } from '@/marketing/ui/forms';

export default async function VideoDetailPage({ params }: { params: { id: string } }) {
  const { actor, isAdmin } = await requireMarketingViewer();
  const { project, phase, scenes, validation } = await orNotFound(getVideoProject(params.id, actor));
  const editable = phase !== 'RENDERING' && phase !== 'COMPLETED';
  const renderable = isAdmin && project.status === 'APPROVED' && project.approvedVersion === project.version && (project.renderStatus === 'NOT_STARTED' || project.renderStatus === 'FAILED');

  return (
    <div className="space-y-6">
      <PageHeader
        title={project.title}
        subtitle={`${project.platform.replace(/_/g, ' ')} · ${project.language} · ${project.aspectRatio} · v${project.version}`}
        actions={<StatusBadge label={phase} />}
      />

      <div className="card p-5 flex flex-wrap items-start justify-between gap-4">
        <dl className="grid grid-cols-2 sm:grid-cols-4 gap-x-8 gap-y-3 text-sm">
          <div><dt className="text-slate-500">Campaign</dt><dd>{project.campaignId ? <Link className="text-brand-700 hover:underline" href={`/marketing/campaigns/${project.campaignId}`}>Open</Link> : '—'}</dd></div>
          <div><dt className="text-slate-500">Render</dt><dd><StatusBadge label={project.renderStatus} /></dd></div>
          <div><dt className="text-slate-500">Duration</dt><dd>{validation.totalDurationSec}s{project.targetDurationSec ? ` / target ${project.targetDurationSec}s` : ''}</dd></div>
          <div><dt className="text-slate-500">Rendered</dt><dd>{project.renderedAt ? formatDateTime(project.renderedAt) : '—'}</dd></div>
        </dl>
        <div className="flex flex-col gap-2 items-end">
          <TransitionButtons
            status={project.status}
            role={actor.role}
            url={`/api/marketing/videos/${project.id}/transition`}
            targets={['HUMAN_REVIEW', 'APPROVED', 'REJECTED', 'DRAFT']}
            reviewAlias="REVIEW"
            warnVerdict={validation.verdict === 'WARN'}
          />
          {renderable && <ApiButton label="Queue render" url={`/api/marketing/videos/${project.id}/render`} variant="primary" confirmText="Send the approved version to n8n for rendering?" />}
        </div>
        {project.errorMessage && <p className="text-sm text-red-700 w-full">{project.errorMessage}</p>}
      </div>

      <div className="card p-5">
        <div className="flex items-center gap-2 mb-3">
          <h2 className="font-semibold text-slate-800">Platform validation</h2>
          <StatusBadge label={validation.verdict} />
        </div>
        {validation.issues.length === 0 ? (
          <p className="text-sm text-green-700">No issues.</p>
        ) : (
          <ul className="text-sm space-y-1">
            {validation.issues.map((i, n) => (
              <li key={n} className={i.severity === 'BLOCK' ? 'text-red-700' : 'text-amber-700'}>{i.message}</li>
            ))}
          </ul>
        )}
      </div>

      <div className="card p-5">
        <h2 className="font-semibold text-slate-800 mb-3">Scenes ({scenes.length})</h2>
        <div className="overflow-x-auto">
          <table className="table-base">
            <thead>
              <tr>
                <th>#</th>
                <th>On-screen text</th>
                <th>Voiceover</th>
                <th>Visual</th>
                <th>Sec</th>
                <th>Transition</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {scenes.map((s) => (
                <tr key={s.id} className="align-top">
                  <td>{s.order}</td>
                  <td className="max-w-xs">{s.onScreenText || '—'}</td>
                  <td className="max-w-xs text-slate-600">{s.voiceover || '—'}</td>
                  <td className="max-w-xs text-slate-600">{s.visualCue || '—'}</td>
                  <td className="tabular-nums">{s.durationSec == null ? '—' : toNumber(s.durationSec)}</td>
                  <td className="text-xs">{s.transition}</td>
                  <td>
                    {editable && (
                      <ApiButton label="Remove" method="DELETE" url={`/api/marketing/videos/${project.id}/scenes/${s.id}`} confirmText="Remove this scene? The project returns to DRAFT." />
                    )}
                  </td>
                </tr>
              ))}
              {scenes.length === 0 && (
                <tr>
                  <td colSpan={7} className="text-center text-slate-400 py-6">No scenes yet.</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        {editable && (
          <div className="mt-4">
            <AddSceneForm projectId={project.id} />
          </div>
        )}
      </div>
    </div>
  );
}
