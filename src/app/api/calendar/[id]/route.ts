import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { requireApiModule } from '@/lib/api-auth';

export async function DELETE(_req: NextRequest, { params }: { params: { id: string } }) {
  const session = await requireApiModule('calendar');
  if (session instanceof NextResponse) return session;
  await prisma.calendarEvent.delete({ where: { id: params.id } });
  return NextResponse.json({ ok: true });
}
