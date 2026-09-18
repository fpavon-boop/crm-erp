import Link from 'next/link';
import { prisma } from '@/lib/prisma';
import { requireModule } from '@/lib/session';
import PageHeader from '@/components/PageHeader';
import Badge from '@/components/Badge';
import { formatDate } from '@/lib/format';
import { Plus, Download } from 'lucide-react';

export default async function EmployeesPage() {
  await requireModule('employees');
  const employees = await prisma.employee.findMany({ orderBy: { firstName: 'asc' } });

  return (
    <div>
      <PageHeader
        title="Employees"
        subtitle={`${employees.length} employees`}
        actions={
          <>
            <a href="/api/employees?format=csv" className="btn-secondary"><Download size={16} /> Export CSV</a>
            <Link href="/employees/new" className="btn-primary"><Plus size={16} /> New Employee</Link>
          </>
        }
      />
      <div className="card overflow-x-auto">
        <table className="table-base">
          <thead><tr><th>Name</th><th>Position</th><th>Department</th><th>Email</th><th>Hire date</th><th>Status</th><th /></tr></thead>
          <tbody>
            {employees.map((e) => (
              <tr key={e.id} className="hover:bg-slate-50">
                <td className="font-medium">{e.firstName} {e.lastName}</td>
                <td>{e.position || '—'}</td>
                <td>{e.department || '—'}</td>
                <td>{e.email || '—'}</td>
                <td>{formatDate(e.hireDate)}</td>
                <td><Badge label={e.active ? 'active' : 'inactive'} /></td>
                <td><Link href={`/employees/${e.id}/edit`} className="text-brand-700 hover:underline text-sm">Edit</Link></td>
              </tr>
            ))}
            {employees.length === 0 && <tr><td colSpan={7} className="text-center text-slate-500 py-8">No employees yet.</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}
