import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { requireApiModule } from '@/lib/api-auth';

export async function GET(req: NextRequest) {
  const session = await requireApiModule('inbox');
  if (session instanceof NextResponse) return session;

  const unansweredOnly = req.nextUrl.searchParams.get('unanswered') === '1';

  const messages = await prisma.emailMessage.findMany({
    where: unansweredOnly ? { direction: 'INBOUND', isAnswered: false } : undefined,
    include: { company: true, contact: true, attachments: true },
    orderBy: { receivedAt: 'desc' },
    take: 100,
  });
  return NextResponse.json({ messages });
}
