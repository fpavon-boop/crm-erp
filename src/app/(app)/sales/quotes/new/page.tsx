import { requireModule } from '@/lib/session';
import PageHeader from '@/components/PageHeader';
import QuoteForm from '../QuoteForm';

export default async function NewQuotePage() {
  await requireModule('sales');
  return (
    <div>
      <PageHeader title="New Quote" />
      <QuoteForm />
    </div>
  );
}
