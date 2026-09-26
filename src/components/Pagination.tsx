import Link from 'next/link';
import { totalPages as computeTotalPages, DEFAULT_PAGE_SIZE } from '@/lib/pagination';

/**
 * Plain `<Link href="?page=N">` pagination for a server-rendered list page
 * (SYSTEM_AUDIT.md F4) — no client state, matching every other filter on
 * these pages (a GET `<form>` that reloads the page). `searchParams`
 * should be the page's own filters (e.g. `{ q, type }`) with `page`
 * omitted; this component adds `page` itself for each link.
 */
export default function Pagination({
  page,
  total,
  pageSize = DEFAULT_PAGE_SIZE,
  basePath,
  searchParams,
}: {
  page: number;
  total: number;
  pageSize?: number;
  basePath: string;
  searchParams: Record<string, string | undefined>;
}) {
  const pages = computeTotalPages(total, pageSize);
  if (pages <= 1) return null;

  function hrefFor(p: number): string {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(searchParams)) {
      if (value) params.set(key, value);
    }
    params.set('page', String(p));
    return `${basePath}?${params.toString()}`;
  }

  const from = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const to = Math.min(page * pageSize, total);

  return (
    <div className="flex items-center justify-between mt-4 text-sm text-slate-600">
      <span>
        Showing {from}-{to} of {total}
      </span>
      <div className="flex items-center gap-2">
        {page > 1 ? (
          <Link href={hrefFor(page - 1)} className="btn-secondary !py-1 !text-xs">
            Previous
          </Link>
        ) : (
          <span className="btn-secondary !py-1 !text-xs opacity-50 pointer-events-none">Previous</span>
        )}
        <span className="text-xs text-slate-500">
          Page {page} of {pages}
        </span>
        {page < pages ? (
          <Link href={hrefFor(page + 1)} className="btn-secondary !py-1 !text-xs">
            Next
          </Link>
        ) : (
          <span className="btn-secondary !py-1 !text-xs opacity-50 pointer-events-none">Next</span>
        )}
      </div>
    </div>
  );
}
