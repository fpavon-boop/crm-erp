import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { requireApiModule } from '@/lib/api-auth';
import { calendarEventSchema } from '@/lib/validation';

export async function GET(req: NextRequest) {
  const session = await requireApiModule('calendar');
  if (session instanceof NextResponse) return session;

  const from = req.nextUrl.searchParams.get('from');
  const to = req.nextUrl.searchParams.get('to');

  const events = await prisma.calendarEvent.findMany({
    where: from && to ? { startsAt: { gte: new Date(from) }, endsAt: { lte: new Date(to) } } : undefined,
    orderBy: { startsAt: 'asc' },
  });
  return NextResponse.json({ events });
}

export async function POST(req: NextRequest) {
  const session = await requireApiModule('calendar');
  if (session instanceof NextResponse) return session;

  const body = await req.json();
  const parsed = calendarEventSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });

  const event = await prisma.calendarEvent.create({
    data: {
      ...parsed.data,
      startsAt: new Date(parsed.data.startsAt),
      endsAt: new Date(parsed.data.endsAt),
      createdById: session.user.id,
    },
  });
  return NextResponse.json({ event }, { status: 201 });
}
