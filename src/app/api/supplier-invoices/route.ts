import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { requireApiModule } from '@/lib/api-auth';
import { supplierInvoiceSchema } from '@/lib/validation';
import { createSupplierInvoiceSafely, DuplicateSupplierInvoiceNumberError } from '@/lib/supplier-invoices';

export async function GET() {
  const session = await requireApiModule('purchasing');
  if (session instanceof NextResponse) return session;

  const invoices = await prisma.supplierInvoice.findMany({
    include: { supplier: true, purchaseOrder: true },
    orderBy: { createdAt: 'desc' },
  });
  return NextResponse.json({ invoices });
}

export async function POST(req: NextRequest) {
  const session = await requireApiModule('purchasing');
  if (session instanceof NextResponse) return session;

  const body = await req.json();
  const parsed = supplierInvoiceSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });

  const { dueDate, ...rest } = parsed.data;
  try {
    const invoice = await createSupplierInvoiceSafely({ ...rest, dueDate: dueDate ? new Date(dueDate) : null });
    return NextResponse.json({ invoice }, { status: 201 });
  } catch (err) {
    if (err instanceof DuplicateSupplierInvoiceNumberError) {
      return NextResponse.json({ error: err.message }, { status: 409 });
    }
    throw err;
  }
}
