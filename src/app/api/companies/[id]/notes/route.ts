import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { requireApiModule } from '@/lib/api-auth';

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const session = await requireApiModule('companies');
  if (session instanceof NextResponse) return session;

  const { body } = await req.json();
  if (!body || typeof body !== 'string') {
    return NextResponse.json({ error: 'body is required' }, { status: 400 });
  }

  const note = await prisma.note.create({
    data: {
      entityType: 'COMPANY',
      entityId: params.id,
      companyId: params.id,
      body,
      authorId: session.user.id,
    },
  });

  await prisma.communicationLog.create({
    data: {
      type: 'NOTE',
      direction: 'OUTBOUND',
      body,
      companyId: params.id,
      userId: session.user.id,
    },
  });

  return NextResponse.json({ note }, { status: 201 });
}
