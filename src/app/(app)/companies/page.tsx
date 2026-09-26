import Link from 'next/link';
import { prisma } from '@/lib/prisma';
import { requireModule } from '@/lib/session';
import PageHeader from '@/components/PageHeader';
import Badge from '@/components/Badge';
import Pagination from '@/components/Pagination';
import { parsePage, pageWindow } from '@/lib/pagination';
import { Plus, Download } from 'lucide-react';

export default async function CompaniesPage({
  searchParams,
}: {
  searchParams: { q?: string; type?: string; page?: string };
}) {
  await requireModule('companies');

  const q = searchParams.q?.trim();
  const type = searchParams.type;
  const page = parsePage(searchParams.page);

  const where = {
    ...(q ? { name: { contains: q, mode: 'insensitive' as const } } : {}),
    ...(type ? { type: type as never } : {}),
  };

  const [companies, total] = await Promise.all([
    prisma.company.findMany({
      where,
      include: { phones: true, emails: true, _count: { select: { contacts: true } } },
      orderBy: { name: 'asc' },
      ...pageWindow(page),
    }),
    prisma.company.count({ where }),
  ]);

  return (
    <div>
      <PageHeader
        title="Companies"
        subtitle={`${total} companies`}
        actions={
          <>
            <a href={`/api/companies?format=csv${type ? `&type=${type}` : ''}${q ? `&q=${q}` : ''}`} className="btn-secondary">
              <Download size={16} /> Export CSV
            </a>
            <Link href="/companies/new" className="btn-primary">
              <Plus size={16} /> New Company
            </Link>
          </>
        }
      />

      <form className="card p-4 mb-4 flex gap-3 flex-wrap" method="get">
        <input
          name="q"
          defaultValue={q}
          placeholder="Search by name..."
          className="input max-w-xs"
        />
        <select name="type" defaultValue={type} className="input max-w-[180px]">
          <option value="">All types</option>
          <option value="CUSTOMER">Customer</option>
          <option value="SUPPLIER">Supplier</option>
          <option value="BOTH">Both</option>
          <option value="PARTNER">Partner</option>
        </select>
        <button type="submit" className="btn-secondary">Filter</button>
      </form>

      <div className="card overflow-x-auto">
        <table className="table-base">
          <thead>
            <tr>
              <th>Name</th>
              <th>Type</th>
              <th>Contacts</th>
              <th>Email</th>
              <th>Phone</th>
              <th>Location</th>
            </tr>
          </thead>
          <tbody>
            {companies.map((c) => (
              <tr key={c.id} className="hover:bg-slate-50">
                <td>
                  <Link href={`/companies/${c.id}`} className="font-medium text-brand-700 hover:underline">
                    {c.name}
                  </Link>
                </td>
                <td><Badge label={c.type} /></td>
                <td>{c._count.contacts}</td>
                <td>{c.emails[0]?.address || '—'}</td>
                <td>{c.phones[0]?.number || '—'}</td>
                <td>{[c.city, c.country].filter(Boolean).join(', ') || '—'}</td>
              </tr>
            ))}
            {companies.length === 0 && (
              <tr>
                <td colSpan={6} className="text-center text-slate-500 py-8">
                  No companies found.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <Pagination page={page} total={total} basePath="/companies" searchParams={{ q, type }} />
    </div>
  );
}
