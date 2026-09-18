import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { requireApiModule } from '@/lib/api-auth';
import { companySchema } from '@/lib/validation';
import { logAudit } from '@/lib/audit';

export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const session = await requireApiModule('companies');
  if (session instanceof NextResponse) return session;

  const company = await prisma.company.findUnique({
    where: { id: params.id },
    include: {
      phones: true,
      emails: true,
      contacts: true,
      owner: true,
      invoices: { orderBy: { createdAt: 'desc' }, take: 20 },
      salesOrders: { orderBy: { createdAt: 'desc' }, take: 20 },
      quotes: { orderBy: { createdAt: 'desc' }, take: 20 },
      purchaseOrders: { orderBy: { createdAt: 'desc' }, take: 20 },
      documents: { orderBy: { createdAt: 'desc' } },
      notesList: { orderBy: { createdAt: 'desc' }, include: { author: true } },
      communicationLogs: { orderBy: { occurredAt: 'desc' }, take: 50 },
    },
  });
  if (!company) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const unpaidInvoices = await prisma.invoice.findMany({
    where: { companyId: company.id, status: { in: ['SENT', 'PARTIAL', 'OVERDUE'] } },
    select: { total: true, amountPaid: true },
  });
  const accountBalance = unpaidInvoices.reduce(
    (sum, inv) => sum + (Number(inv.total) - Number(inv.amountPaid)),
    0
  );

  return NextResponse.json({ company, accountBalance });
}

export async function PUT(req: NextRequest, { params }: { params: { id: string } }) {
  const session = await requireApiModule('companies');
  if (session instanceof NextResponse) return session;

  const body = await req.json();
  const parsed = companySchema.partial().safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }
  const { phones, emails, ...data } = parsed.data;

  const company = await prisma.company.update({
    where: { id: params.id },
    data: {
      ...data,
      ...(phones
        ? { phones: { deleteMany: {}, create: phones } }
        : {}),
      ...(emails
        ? { emails: { deleteMany: {}, create: emails } }
        : {}),
    },
  });

  await logAudit({
    userId: session.user.id,
    action: 'UPDATE',
    entityType: 'Company',
    entityId: company.id,
    companyId: company.id,
    changes: data,
  });

  return NextResponse.json({ company });
}

export async function DELETE(req: NextRequest, { params }: { params: { id: string } }) {
  const session = await requireApiModule('companies');
  if (session instanceof NextResponse) return session;
  if (session.user.role !== 'ADMIN') {
    return NextResponse.json({ error: 'Only admins can delete companies' }, { status: 403 });
  }

  await prisma.company.delete({ where: { id: params.id } });
  await logAudit({
    userId: session.user.id,
    action: 'DELETE',
    entityType: 'Company',
    entityId: params.id,
  });

  return NextResponse.json({ ok: true });
}
