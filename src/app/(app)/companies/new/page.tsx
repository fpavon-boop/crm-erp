import { requireModule } from '@/lib/session';
import PageHeader from '@/components/PageHeader';
import CompanyForm from '../CompanyForm';

export default async function NewCompanyPage() {
  await requireModule('companies');
  return (
    <div>
      <PageHeader title="New Company" />
      <CompanyForm />
    </div>
  );
}
