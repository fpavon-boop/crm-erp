import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { requireApiModule } from '@/lib/api-auth';
import { taskSchema } from '@/lib/validation';

export async function PUT(req: NextRequest, { params }: { params: { id: string } }) {
  const session = await requireApiModule('tasks');
  if (session instanceof NextResponse) return session;

  const body = await req.json();
  const parsed = taskSchema.partial().safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });

  const { dueDate, ...rest } = parsed.data;
  const task = await prisma.task.update({
    where: { id: params.id },
    data: { ...rest, dueDate: dueDate ? new Date(dueDate) : undefined },
  });
  return NextResponse.json({ task });
}

export async function DELETE(_req: NextRequest, { params }: { params: { id: string } }) {
  const session = await requireApiModule('tasks');
  if (session instanceof NextResponse) return session;
  await prisma.task.delete({ where: { id: params.id } });
  return NextResponse.json({ ok: true });
}
