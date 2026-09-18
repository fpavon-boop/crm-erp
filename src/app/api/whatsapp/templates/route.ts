import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { requireApiModule } from '@/lib/api-auth';
import { z } from 'zod';

const schema = z.object({
  name: z.string().min(1),
  language: z.string().default('en_US'),
  category: z.string().min(1),
  bodyText: z.string().min(1),
});

export async function GET() {
  const session = await requireApiModule('whatsapp');
  if (session instanceof NextResponse) return session;
  const templates = await prisma.whatsAppTemplate.findMany({ orderBy: { name: 'asc' } });
  return NextResponse.json({ templates });
}

export async function POST(req: NextRequest) {
  const session = await requireApiModule('whatsapp');
  if (session instanceof NextResponse) return session;

  const body = await req.json();
  const parsed = schema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });

  const template = await prisma.whatsAppTemplate.create({ data: parsed.data });
  return NextResponse.json({ template }, { status: 201 });
}
