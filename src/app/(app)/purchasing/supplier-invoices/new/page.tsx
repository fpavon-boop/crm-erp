import { requireModule } from '@/lib/session';
import PageHeader from '@/components/PageHeader';
import SupplierInvoiceForm from './SupplierInvoiceForm';

export default async function NewSupplierInvoicePage() {
  await requireModule('purchasing');
  return (
    <div>
      <PageHeader title="New Supplier Invoice" />
      <SupplierInvoiceForm />
    </div>
  );
}
