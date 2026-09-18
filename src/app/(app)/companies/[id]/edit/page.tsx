import { notFound } from 'next/navigation';
import { prisma } from '@/lib/prisma';
import { requireModule } from '@/lib/session';
import PageHeader from '@/components/PageHeader';
import CompanyForm from '../../CompanyForm';

export default async function EditCompanyPage({ params }: { params: { id: string } }) {
  await requireModule('companies');
  const company = await prisma.company.findUnique({
    where: { id: params.id },
    include: { phones: true, emails: true },
  });
  if (!company) notFound();

  return (
    <div>
      <PageHeader title={`Edit ${company.name}`} />
      <CompanyForm
        initial={{
          id: company.id,
          name: company.name,
          type: company.type,
          taxId: company.taxId || '',
          industry: company.industry || '',
          website: company.website || '',
          addressLine1: company.addressLine1 || '',
          addressLine2: company.addressLine2 || '',
          city: company.city || '',
          state: company.state || '',
          postalCode: company.postalCode || '',
          country: company.country || '',
          notes: company.notes || '',
          phone: company.phones[0]?.number || '',
          email: company.emails[0]?.address || '',
        }}
      />
    </div>
  );
}
