import { requireModule } from '@/lib/session';
import PageHeader from '@/components/PageHeader';
import EmployeeForm from '../EmployeeForm';

export default async function NewEmployeePage() {
  await requireModule('employees');
  return (
    <div>
      <PageHeader title="New Employee" />
      <EmployeeForm />
    </div>
  );
}
