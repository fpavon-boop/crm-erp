import { notFound } from 'next/navigation';
import { prisma } from '@/lib/prisma';
import { requireModule } from '@/lib/session';
import PageHeader from '@/components/PageHeader';
import ContactForm from '../../ContactForm';

export default async function EditContactPage({ params }: { params: { id: string } }) {
  await requireModule('contacts');
  const contact = await prisma.contact.findUnique({ where: { id: params.id } });
  if (!contact) notFound();

  return (
    <div>
      <PageHeader title={`Edit ${contact.firstName} ${contact.lastName}`} />
      <ContactForm
        initial={{
          id: contact.id,
          firstName: contact.firstName,
          lastName: contact.lastName,
          email: contact.email || '',
          phone: contact.phone || '',
          mobile: contact.mobile || '',
          position: contact.position || '',
          companyId: contact.companyId || '',
          notes: contact.notes || '',
        }}
      />
    </div>
  );
}
