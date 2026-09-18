import { requireModule } from '@/lib/session';
import PageHeader from '@/components/PageHeader';
import ContactForm from '../ContactForm';

export default async function NewContactPage() {
  await requireModule('contacts');
  return (
    <div>
      <PageHeader title="New Contact" />
      <ContactForm />
    </div>
  );
}
