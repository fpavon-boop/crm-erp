import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { requireApiModule } from '@/lib/api-auth';
import { contactSchema } from '@/lib/validation';
import { logAudit } from '@/lib/audit';
import { csvResponse } from '@/lib/csv';
import { findPossibleDuplicateContacts } from '@/lib/duplicate-detection';

export async function GET(req: NextRequest) {
  const session = await requireApiModule('contacts');
  if (session instanceof NextResponse) return session;

  const { searchParams } = req.nextUrl;
  const q = searchParams.get('q') || undefined;
  const companyId = searchParams.get('companyId') || undefined;
  const format = searchParams.get('format');

  const contacts = await prisma.contact.findMany({
    where: {
      ...(companyId ? { companyId } : {}),
      ...(q
        ? {
            OR: [
              { firstName: { contains: q, mode: 'insensitive' as const } },
              { lastName: { contains: q, mode: 'insensitive' as const } },
              { email: { contains: q, mode: 'insensitive' as const } },
            ],
          }
        : {}),
    },
    include: { company: true },
    orderBy: { firstName: 'asc' },
  });

  if (format === 'csv') {
    return csvResponse(
      'contacts.csv',
      contacts.map((c) => ({
        firstName: c.firstName,
        lastName: c.lastName,
        email: c.email,
        phone: c.phone,
        company: c.company?.name,
        position: c.position,
        createdAt: c.createdAt,
      }))
    );
  }

  return NextResponse.json({ contacts });
}

export async function POST(req: NextRequest) {
  const session = await requireApiModule('contacts');
  if (session instanceof NextResponse) return session;

  const body = await req.json();
  const parsed = contactSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });

  // A possible-duplicate warning, not a hard block — see
  // src/lib/duplicate-detection.ts. `confirmDuplicate: true` (sent when
  // the user clicks "Create anyway" on the warning) skips this check.
  if (body?.confirmDuplicate !== true) {
    const matches = await findPossibleDuplicateContacts({
      email: parsed.data.email,
      firstName: parsed.data.firstName,
      lastName: parsed.data.lastName,
    });
    if (matches.length > 0) {
      return NextResponse.json({ duplicate: true, matches }, { status: 409 });
    }
  }

  const contact = await prisma.contact.create({ data: { ...parsed.data, email: parsed.data.email || null } });
  await logAudit({
    userId: session.user.id,
    action: 'CREATE',
    entityType: 'Contact',
    entityId: contact.id,
    companyId: contact.companyId,
    changes: parsed.data,
  });

  return NextResponse.json({ contact }, { status: 201 });
}
