import { notFound } from 'next/navigation';
import { prisma } from '@/lib/prisma';
import { requireModule } from '@/lib/session';
import PageHeader from '@/components/PageHeader';
import OrderForm from '../../OrderForm';

export default async function EditOrderPage({ params }: { params: { id: string } }) {
  await requireModule('sales');
  const order = await prisma.salesOrder.findUnique({ where: { id: params.id }, include: { items: true } });
  if (!order) notFound();

  return (
    <div>
      <PageHeader title={`Edit ${order.number}`} />
      <OrderForm
        initial={{
          id: order.id,
          companyId: order.companyId || '',
          contactId: order.contactId || '',
          status: order.status,
          notes: order.notes || '',
          items: order.items.map((i) => ({
            productId: i.productId,
            productVariantId: i.productVariantId,
            description: i.description,
            quantity: Number(i.quantity),
            unitPrice: Number(i.unitPrice),
            taxRate: Number(i.taxRate),
            discount: Number(i.discount),
          })),
        }}
      />
    </div>
  );
}
