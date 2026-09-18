import { requireModule } from '@/lib/session';
import PageHeader from '@/components/PageHeader';
import ProductForm from '../ProductForm';

export default async function NewProductPage() {
  await requireModule('inventory');
  return (
    <div>
      <PageHeader title="New Product" />
      <ProductForm />
    </div>
  );
}
