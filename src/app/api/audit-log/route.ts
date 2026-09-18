import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { requireApiModule } from '@/lib/api-auth';
import { csvResponse } from '@/lib/csv';

export async function GET(req: NextRequest) {
  const session = await requireApiModule('settings');
  if (session instanceof NextResponse) return session;

  const logs = await prisma.auditLog.findMany({
    include: { user: true, company: true },
    orderBy: { createdAt: 'desc' },
    take: 1000,
  });

  if (req.nextUrl.searchParams.get('format') === 'csv') {
    return csvResponse('audit-log.csv', logs.map((l) => ({
      date: l.createdAt,
      user: l.user?.name,
      action: l.action,
      entityType: l.entityType,
      entityId: l.entityId,
      company: l.company?.name,
    })));
  }

  return NextResponse.json({ logs });
}
