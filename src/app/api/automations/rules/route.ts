import { NextRequest, NextResponse } from 'next/server';
import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { requireApiModule } from '@/lib/api-auth';
import { automationRuleSchema } from '@/lib/validation';

export async function GET() {
  const session = await requireApiModule('automations');
  if (session instanceof NextResponse) return session;
  const rules = await prisma.automationRule.findMany({ orderBy: { createdAt: 'desc' } });
  return NextResponse.json({ rules });
}

export async function POST(req: NextRequest) {
  const session = await requireApiModule('automations');
  if (session instanceof NextResponse) return session;

  const body = await req.json();
  const parsed = automationRuleSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });

  const rule = await prisma.automationRule.create({
    data: {
      ...parsed.data,
      actions: parsed.data.actions as Prisma.InputJsonValue,
      conditions: parsed.data.conditions as Prisma.InputJsonValue | undefined,
      createdById: session.user.id,
    },
  });
  return NextResponse.json({ rule }, { status: 201 });
}
