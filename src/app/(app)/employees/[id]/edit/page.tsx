import { notFound } from 'next/navigation';
import { prisma } from '@/lib/prisma';
import { requireModule } from '@/lib/session';
import PageHeader from '@/components/PageHeader';
import EmployeeForm from '../../EmployeeForm';

export default async function EditEmployeePage({ params }: { params: { id: string } }) {
  await requireModule('employees');
  const employee = await prisma.employee.findUnique({ where: { id: params.id } });
  if (!employee) notFound();

  return (
    <div>
      <PageHeader title={`Edit ${employee.firstName} ${employee.lastName}`} />
      <EmployeeForm
        initial={{
          id: employee.id,
          firstName: employee.firstName,
          lastName: employee.lastName,
          email: employee.email || '',
          phone: employee.phone || '',
          position: employee.position || '',
          department: employee.department || '',
          hireDate: employee.hireDate ? employee.hireDate.toISOString().slice(0, 10) : '',
          notes: employee.notes || '',
        }}
      />
    </div>
  );
}
