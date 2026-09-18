import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { requireApiModule } from '@/lib/api-auth';
import { contactSchema } from '@/lib/validation';
import { logAudit } from '@/lib/audit';

export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const session = await requireApiModule('contacts');
  if (session instanceof NextResponse) return session;

  const contact = await prisma.contact.findUnique({
    where: { id: params.id },
    include: {
      company: true,
      opportunities: true,
      quotes: { orderBy: { createdAt: 'desc' } },
      salesOrders: { orderBy: { createdAt: 'desc' } },
      invoices: { orderBy: { createdAt: 'desc' } },
      notesList: { orderBy: { createdAt: 'desc' }, include: { author: true } },
      communicationLogs: { orderBy: { occurredAt: 'desc' } },
      emailMessages: { orderBy: { receivedAt: 'desc' }, take: 10 },
      whatsappMessages: { orderBy: { timestamp: 'desc' }, take: 10 },
    },
  });
  if (!contact) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  return NextResponse.json({ contact });
}

export async function PUT(req: NextRequest, { params }: { params: { id: string } }) {
  const session = await requireApiModule('contacts');
  if (session instanceof NextResponse) return session;

  const body = await req.json();
  const parsed = contactSchema.partial().safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });

  const contact = await prisma.contact.update({
    where: { id: params.id },
    data: { ...parsed.data, email: parsed.data.email || null },
  });
  await logAudit({
    userId: session.user.id,
    action: 'UPDATE',
    entityType: 'Contact',
    entityId: contact.id,
    companyId: contact.companyId,
    changes: parsed.data,
  });
  return NextResponse.json({ contact });
}

export async function DELETE(req: NextRequest, { params }: { params: { id: string } }) {
  const session = await requireApiModule('contacts');
  if (session instanceof NextResponse) return session;

  await prisma.contact.delete({ where: { id: params.id } });
  await logAudit({ userId: session.user.id, action: 'DELETE', entityType: 'Contact', entityId: params.id });
  return NextResponse.json({ ok: true });
}
