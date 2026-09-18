import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { requireApiModule } from '@/lib/api-auth';
import { taskSchema } from '@/lib/validation';

export async function GET(req: NextRequest) {
  const session = await requireApiModule('tasks');
  if (session instanceof NextResponse) return session;

  const status = req.nextUrl.searchParams.get('status') || undefined;
  const tasks = await prisma.task.findMany({
    where: status ? { status: status as never } : undefined,
    include: { assignee: true },
    orderBy: [{ status: 'asc' }, { dueDate: 'asc' }],
  });
  return NextResponse.json({ tasks });
}

export async function POST(req: NextRequest) {
  const session = await requireApiModule('tasks');
  if (session instanceof NextResponse) return session;

  const body = await req.json();
  const parsed = taskSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });

  const { dueDate, ...rest } = parsed.data;
  const task = await prisma.task.create({
    data: { ...rest, dueDate: dueDate ? new Date(dueDate) : null, createdById: session.user.id },
  });
  return NextResponse.json({ task }, { status: 201 });
}
