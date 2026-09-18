import { prisma } from '@/lib/prisma';
import { requireModule } from '@/lib/session';
import PageHeader from '@/components/PageHeader';
import CalendarClient from './CalendarClient';

export default async function CalendarPage() {
  await requireModule('calendar');
  const events = await prisma.calendarEvent.findMany({
    where: { startsAt: { gte: new Date(Date.now() - 1000 * 60 * 60 * 24) } },
    orderBy: { startsAt: 'asc' },
    take: 100,
  });

  return (
    <div>
      <PageHeader title="Calendar" subtitle="Upcoming events for sales & operations follow-up" />
      <CalendarClient
        initial={events.map((e) => ({
          id: e.id,
          title: e.title,
          description: e.description,
          startsAt: e.startsAt.toISOString(),
          endsAt: e.endsAt.toISOString(),
        }))}
      />
    </div>
  );
}
