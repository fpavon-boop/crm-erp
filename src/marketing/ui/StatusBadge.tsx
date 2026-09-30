/** Marketing statuses/phases/verdicts. Kept separate from the core Badge so
 * the core colour map is not edited by the marketing module. */
const COLORS: Record<string, string> = {
  DRAFT: 'bg-slate-100 text-slate-700',
  AI_GENERATED: 'bg-violet-100 text-violet-700',
  HUMAN_REVIEW: 'bg-amber-100 text-amber-700',
  REVIEW: 'bg-amber-100 text-amber-700',
  APPROVED: 'bg-green-100 text-green-700',
  REJECTED: 'bg-red-100 text-red-700',
  SCHEDULED: 'bg-blue-100 text-blue-700',
  DISPATCHED: 'bg-indigo-100 text-indigo-700',
  RENDERING: 'bg-indigo-100 text-indigo-700',
  PUBLISHED: 'bg-emerald-100 text-emerald-800',
  COMPLETED: 'bg-emerald-100 text-emerald-800',
  FAILED: 'bg-red-100 text-red-700',
  PASS: 'bg-green-100 text-green-700',
  WARN: 'bg-amber-100 text-amber-700',
  BLOCK: 'bg-red-100 text-red-700',
  ACTIVE: 'bg-green-100 text-green-700',
  DISCONNECTED: 'bg-amber-100 text-amber-700',
  REVOKED: 'bg-red-100 text-red-700',
};

export default function StatusBadge({ label }: { label: string }) {
  return <span className={`badge ${COLORS[label] ?? 'bg-slate-100 text-slate-700'}`}>{label.replace(/_/g, ' ')}</span>;
}
