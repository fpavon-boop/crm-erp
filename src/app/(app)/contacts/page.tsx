import Link from 'next/link';
import { prisma } from '@/lib/prisma';
import { requireModule } from '@/lib/session';
import PageHeader from '@/components/PageHeader';
import { Plus, Download } from 'lucide-react';

export default async function ContactsPage({ searchParams }: { searchParams: { q?: string } }) {
  await requireModule('contacts');
  const q = searchParams.q?.trim();

  const contacts = await prisma.contact.findMany({
    where: q
      ? {
          OR: [
            { firstName: { contains: q, mode: 'insensitive' } },
            { lastName: { contains: q, mode: 'insensitive' } },
            { email: { contains: q, mode: 'insensitive' } },
          ],
        }
      : undefined,
    include: { company: true },
    orderBy: { firstName: 'asc' },
  });

  return (
    <div>
      <PageHeader
        title="Contacts"
        subtitle={`${contacts.length} contacts`}
        actions={
          <>
            <a href={`/api/contacts?format=csv${q ? `&q=${q}` : ''}`} className="btn-secondary">
              <Download size={16} /> Export CSV
            </a>
            <Link href="/contacts/new" className="btn-primary">
              <Plus size={16} /> New Contact
            </Link>
          </>
        }
      />

      <form className="card p-4 mb-4 flex gap-3" method="get">
        <input name="q" defaultValue={q} placeholder="Search by name or email..." className="input max-w-xs" />
        <button type="submit" className="btn-secondary">Filter</button>
      </form>

      <div className="card overflow-x-auto">
        <table className="table-base">
          <thead>
            <tr>
              <th>Name</th>
              <th>Company</th>
              <th>Position</th>
              <th>Email</th>
              <th>Phone</th>
            </tr>
          </thead>
          <tbody>
            {contacts.map((c) => (
              <tr key={c.id} className="hover:bg-slate-50">
                <td>
                  <Link href={`/contacts/${c.id}`} className="font-medium text-brand-700 hover:underline">
                    {c.firstName} {c.lastName}
                  </Link>
                </td>
                <td>
                  {c.company ? (
                    <Link href={`/companies/${c.company.id}`} className="hover:underline">
                      {c.company.name}
                    </Link>
                  ) : (
                    '—'
                  )}
                </td>
                <td>{c.position || '—'}</td>
                <td>{c.email || '—'}</td>
                <td>{c.phone || '—'}</td>
              </tr>
            ))}
            {contacts.length === 0 && (
              <tr><td colSpan={5} className="text-center text-slate-500 py-8">No contacts found.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
