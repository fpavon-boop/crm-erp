'use client';

export default function CompanyDetailError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <div className="card p-8 text-center max-w-lg mx-auto mt-12">
      <h2 className="font-semibold text-slate-800 text-lg mb-2">Couldn&apos;t load this customer</h2>
      <p className="text-sm text-slate-500 mb-4">
        Something went wrong while loading this company&apos;s Customer 360 view. This has been recorded; you can try again.
      </p>
      <button onClick={() => reset()} className="btn-secondary">
        Try again
      </button>
    </div>
  );
}
