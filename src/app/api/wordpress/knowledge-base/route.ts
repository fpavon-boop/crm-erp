import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { requireApiModule } from '@/lib/api-auth';

export async function GET(req: NextRequest) {
  const session = await requireApiModule('wordpress');
  if (session instanceof NextResponse) return session;

  const q = req.nextUrl.searchParams.get('q') || undefined;
  const articles = await prisma.knowledgeBaseArticle.findMany({
    where: q
      ? { OR: [{ title: { contains: q, mode: 'insensitive' } }, { content: { contains: q, mode: 'insensitive' } }] }
      : undefined,
    orderBy: { syncedAt: 'desc' },
    take: 100,
  });
  return NextResponse.json({ articles });
}
