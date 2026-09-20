import { prisma } from '@/lib/prisma';
import { requireModule } from '@/lib/session';
import PageHeader from '@/components/PageHeader';
import BillsClient, { type BillRow } from './BillsClient';

export const dynamic = 'force-dynamic';

function toRow(b: Awaited<ReturnType<typeof prisma.billEntry.findMany>>[number]): BillRow {
  return {
    id: b.id,
    status: b.status,
    kind: b.kind,
    vendor: b.vendor,
    invoiceNumber: b.invoiceNumber,
    amount: b.amount === null ? null : Number(b.amount),
    billDate: b.billDate ? b.billDate.toISOString().slice(0, 10) : null,
    dueDate: b.dueDate ? b.dueDate.toISOString().slice(0, 10) : null,
    category: b.category,
    paid: b.paid,
    paymentMethod: b.paymentMethod,
    notes: b.notes,
    fileName: b.fileName,
    hasFile: Boolean(b.storedPath),
    source: b.source,
    createdAt: b.createdAt.toISOString(),
  };
}

export default async function BillsPage() {
  await requireModule('finance');
  const [review, approved] = await Promise.all([
    prisma.billEntry.findMany({ where: { status: 'REVIEW' }, orderBy: { createdAt: 'desc' }, take: 300 }),
    prisma.billEntry.findMany({ where: { status: 'APPROVED' }, orderBy: { createdAt: 'desc' }, take: 50 }),
  ]);

  return (
    <div>
      <PageHeader
        title="Bills"
        subtitle="Upload bills and receipts each month, check them, and approve them into your books"
      />
      <BillsClient initialReview={review.map(toRow)} initialApproved={approved.map(toRow)} />
    </div>
  );
}
