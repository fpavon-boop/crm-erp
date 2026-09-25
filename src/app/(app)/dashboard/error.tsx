'use client';

export default function DashboardError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <div className="card p-8 text-center max-w-lg mx-auto mt-12">
      <h2 className="font-semibold text-slate-800 text-lg mb-2">Couldn&apos;t load the dashboard</h2>
      <p className="text-sm text-slate-500 mb-4">
        Something went wrong while loading dashboard data. This has been recorded; you can try again.
      </p>
      <button onClick={() => reset()} className="btn-secondary">
        Try again
      </button>
    </div>
  );
}
