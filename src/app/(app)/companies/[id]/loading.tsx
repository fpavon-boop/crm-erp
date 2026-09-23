export default function CompanyDetailLoading() {
  return (
    <div className="animate-pulse">
      <div className="h-8 w-64 bg-slate-200 rounded mb-2" />
      <div className="h-4 w-40 bg-slate-100 rounded mb-6" />
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-1 space-y-6">
          {[...Array(4)].map((_, i) => (
            <div key={i} className="card p-5 h-32 bg-slate-50" />
          ))}
        </div>
        <div className="lg:col-span-2 space-y-6">
          {[...Array(3)].map((_, i) => (
            <div key={i} className="card p-5 h-40 bg-slate-50" />
          ))}
        </div>
      </div>
    </div>
  );
}
