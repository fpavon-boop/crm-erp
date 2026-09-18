import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { requireApiSession } from '@/lib/api-auth';
import { renderInvoicePdf } from '@/lib/pdf';

export const runtime = 'nodejs';

export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  const session = await requireApiSession();
  if (session instanceof NextResponse) return session;

  const invoice = await prisma.invoice.findUnique({
    where: { id: params.id },
    include: { items: true, company: true, contact: true },
  });
  if (!invoice) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const pdf = await renderInvoicePdf({
    number: invoice.number,
    type: invoice.type,
    issueDate: invoice.issueDate,
    dueDate: invoice.dueDate,
    status: invoice.status,
    company: invoice.company,
    contact: invoice.contact,
    items: invoice.items.map((i) => ({
      description: i.description,
      quantity: Number(i.quantity),
      unitPrice: Number(i.unitPrice),
      taxRate: Number(i.taxRate),
      discount: Number(i.discount),
    })),
    subtotal: Number(invoice.subtotal),
    taxTotal: Number(invoice.taxTotal),
    discountTotal: Number(invoice.discountTotal),
    total: Number(invoice.total),
    amountPaid: Number(invoice.amountPaid),
    notes: invoice.notes,
  });

  return new NextResponse(new Uint8Array(pdf), {
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="${invoice.number}.pdf"`,
    },
  });
}
