import { notFound } from 'next/navigation';
import { prisma } from '@/lib/prisma';
import { requireModule } from '@/lib/session';
import PageHeader from '@/components/PageHeader';
import ProductForm from '../../ProductForm';

export default async function EditProductPage({ params }: { params: { id: string } }) {
  await requireModule('inventory');
  const product = await prisma.product.findUnique({ where: { id: params.id } });
  if (!product) notFound();

  return (
    <div>
      <PageHeader title={`Edit ${product.name}`} />
      <ProductForm
        initial={{
          id: product.id,
          sku: product.sku,
          name: product.name,
          description: product.description || '',
          category: product.category || '',
          unit: product.unit,
          price: String(product.price),
          cost: String(product.cost),
          taxRate: String(product.taxRate),
          trackInventory: product.trackInventory,
          reorderPoint: String(product.reorderPoint),
        }}
      />
    </div>
  );
}
