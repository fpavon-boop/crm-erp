import { notFound } from 'next/navigation';
import { prisma } from '@/lib/prisma';
import { requireModule } from '@/lib/session';
import PageHeader from '@/components/PageHeader';
import InvoiceForm from '../../InvoiceForm';

export default async function EditInvoicePage({ params }: { params: { id: string } }) {
  await requireModule('invoicing');
  const invoice = await prisma.invoice.findUnique({ where: { id: params.id }, include: { items: true } });
  if (!invoice) notFound();

  return (
    <div>
      <PageHeader title={`Edit ${invoice.number}`} />
      <InvoiceForm
        initial={{
          id: invoice.id,
          type: invoice.type,
          companyId: invoice.companyId || '',
          contactId: invoice.contactId || '',
          status: invoice.status,
          dueDate: invoice.dueDate ? invoice.dueDate.toISOString().slice(0, 10) : '',
          notes: invoice.notes || '',
          items: invoice.items.map((i) => ({
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
