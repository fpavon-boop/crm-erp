import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { requireApiModule } from '@/lib/api-auth';
import { companySchema } from '@/lib/validation';
import { logAudit } from '@/lib/audit';
import { csvResponse } from '@/lib/csv';

export async function GET(req: NextRequest) {
  const session = await requireApiModule('companies');
  if (session instanceof NextResponse) return session;

  const { searchParams } = req.nextUrl;
  const q = searchParams.get('q') || undefined;
  const type = searchParams.get('type') || undefined;
  const format = searchParams.get('format');

  const where = {
    ...(q ? { name: { contains: q, mode: 'insensitive' as const } } : {}),
    ...(type ? { type: type as never } : {}),
  };

  const companies = await prisma.company.findMany({
    where,
    include: { phones: true, emails: true, _count: { select: { contacts: true } } },
    orderBy: { name: 'asc' },
  });

  if (format === 'csv') {
    return csvResponse(
      'companies.csv',
      companies.map((c) => ({
        name: c.name,
        type: c.type,
        taxId: c.taxId,
        website: c.website,
        city: c.city,
        country: c.country,
        email: c.emails[0]?.address,
        phone: c.phones[0]?.number,
        contacts: c._count.contacts,
        createdAt: c.createdAt,
      }))
    );
  }

  return NextResponse.json({ companies });
}

export async function POST(req: NextRequest) {
  const session = await requireApiModule('companies');
  if (session instanceof NextResponse) return session;

  const body = await req.json();
  const parsed = companySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }
  const { phones, emails, ...data } = parsed.data;

  const company = await prisma.company.create({
    data: {
      ...data,
      phones: phones?.length ? { create: phones } : undefined,
      emails: emails?.length ? { create: emails } : undefined,
    },
  });

  await logAudit({
    userId: session.user.id,
    action: 'CREATE',
    entityType: 'Company',
    entityId: company.id,
    companyId: company.id,
    changes: data,
  });

  return NextResponse.json({ company }, { status: 201 });
}
