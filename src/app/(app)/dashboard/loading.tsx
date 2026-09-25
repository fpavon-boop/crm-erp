export default function DashboardLoading() {
  return (
    <div className="animate-pulse">
      <div className="h-8 w-64 bg-slate-200 rounded mb-2" />
      <div className="h-4 w-40 bg-slate-100 rounded mb-6" />
      <div className="card p-4 h-20 bg-slate-50 mb-6" />
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
        {[...Array(4)].map((_, i) => (
          <div key={i} className="card p-5 h-24 bg-slate-50" />
        ))}
      </div>
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {[...Array(3)].map((_, i) => (
          <div key={i} className="card p-5 h-64 bg-slate-50" />
        ))}
      </div>
    </div>
  );
}
