import { requireModule } from '@/lib/session';
import PageHeader from '@/components/PageHeader';
import OrderForm from '../OrderForm';

export default async function NewOrderPage() {
  await requireModule('sales');
  return (
    <div>
      <PageHeader title="New Sales Order" />
      <OrderForm />
    </div>
  );
}
