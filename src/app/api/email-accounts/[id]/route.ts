import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { requireApiModule } from '@/lib/api-auth';

export async function DELETE(_req: NextRequest, { params }: { params: { id: string } }) {
  const session = await requireApiModule('inbox');
  if (session instanceof NextResponse) return session;
  await prisma.emailAccount.deleteMany({ where: { id: params.id, userId: session.user.id } });
  return NextResponse.json({ ok: true });
}
