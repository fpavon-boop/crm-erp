import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { requireApiModule } from '@/lib/api-auth';
import { z } from 'zod';

const schema = z.object({ name: z.string().min(1), baseUrl: z.string().url() });

export async function GET() {
  const session = await requireApiModule('wordpress');
  if (session instanceof NextResponse) return session;
  const sites = await prisma.wordPressSite.findMany({ orderBy: { name: 'asc' } });
  return NextResponse.json({ sites });
}

export async function POST(req: NextRequest) {
  const session = await requireApiModule('wordpress');
  if (session instanceof NextResponse) return session;

  const body = await req.json();
  const parsed = schema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });

  const site = await prisma.wordPressSite.create({ data: { name: parsed.data.name, baseUrl: parsed.data.baseUrl.replace(/\/$/, '') } });
  return NextResponse.json({ site }, { status: 201 });
}
