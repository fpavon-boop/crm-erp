import { NextRequest, NextResponse } from 'next/server';
import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { requireApiModule } from '@/lib/api-auth';
import { automationRuleSchema } from '@/lib/validation';

export async function PUT(req: NextRequest, { params }: { params: { id: string } }) {
  const session = await requireApiModule('automations');
  if (session instanceof NextResponse) return session;

  const body = await req.json();
  const parsed = automationRuleSchema.partial().safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });

  const rule = await prisma.automationRule.update({
    where: { id: params.id },
    data: {
      ...parsed.data,
      actions: parsed.data.actions as Prisma.InputJsonValue | undefined,
      conditions: parsed.data.conditions as Prisma.InputJsonValue | undefined,
    },
  });
  return NextResponse.json({ rule });
}

export async function DELETE(_req: NextRequest, { params }: { params: { id: string } }) {
  const session = await requireApiModule('automations');
  if (session instanceof NextResponse) return session;
  await prisma.automationRule.delete({ where: { id: params.id } });
  return NextResponse.json({ ok: true });
}
