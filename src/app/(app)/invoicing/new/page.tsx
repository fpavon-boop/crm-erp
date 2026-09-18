import { requireModule } from '@/lib/session';
import PageHeader from '@/components/PageHeader';
import InvoiceForm from '../InvoiceForm';

export default async function NewInvoicePage() {
  await requireModule('invoicing');
  return (
    <div>
      <PageHeader title="New Invoice" />
      <InvoiceForm />
    </div>
  );
}
