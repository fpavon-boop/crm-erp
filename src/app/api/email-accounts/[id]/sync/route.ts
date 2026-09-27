import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { requireApiModule } from '@/lib/api-auth';
import { syncEmailAccount } from '@/lib/email/imap';

export const runtime = 'nodejs';
export const maxDuration = 120;

export async function POST(_req: NextRequest, { params }: { params: { id: string } }) {
  const session = await requireApiModule('inbox');
  if (session instanceof NextResponse) return session;

  const account = await prisma.emailAccount.findFirst({
    where: { id: params.id, userId: session.user.id },
    select: { id: true },
  });
  if (!account) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  try {
    const result = await syncEmailAccount(params.id);
    return NextResponse.json(result);
  } catch (err) {
    console.error('Email account sync failed', err);
    return NextResponse.json({ error: 'Sync failed' }, { status: 500 });
  }
}
