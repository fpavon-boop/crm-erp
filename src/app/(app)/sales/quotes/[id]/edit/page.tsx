import { notFound } from 'next/navigation';
import { prisma } from '@/lib/prisma';
import { requireModule } from '@/lib/session';
import PageHeader from '@/components/PageHeader';
import QuoteForm from '../../QuoteForm';

export default async function EditQuotePage({ params }: { params: { id: string } }) {
  await requireModule('sales');
  const quote = await prisma.quote.findUnique({ where: { id: params.id }, include: { items: true } });
  if (!quote) notFound();

  return (
    <div>
      <PageHeader title={`Edit ${quote.number}`} />
      <QuoteForm
        initial={{
          id: quote.id,
          companyId: quote.companyId || '',
          contactId: quote.contactId || '',
          status: quote.status,
          validUntil: quote.validUntil ? quote.validUntil.toISOString().slice(0, 10) : '',
          notes: quote.notes || '',
          items: quote.items.map((i) => ({
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
