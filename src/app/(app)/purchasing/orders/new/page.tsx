import { requireModule } from '@/lib/session';
import PageHeader from '@/components/PageHeader';
import PurchaseOrderForm from '../PurchaseOrderForm';

export default async function NewPurchaseOrderPage() {
  await requireModule('purchasing');
  return (
    <div>
      <PageHeader title="New Purchase Order" />
      <PurchaseOrderForm />
    </div>
  );
}
