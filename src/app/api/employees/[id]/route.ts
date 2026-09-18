import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { requireApiModule } from '@/lib/api-auth';
import { employeeSchema } from '@/lib/validation';

export async function PUT(req: NextRequest, { params }: { params: { id: string } }) {
  const session = await requireApiModule('employees');
  if (session instanceof NextResponse) return session;

  const body = await req.json();
  const parsed = employeeSchema.partial().safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });

  const employee = await prisma.employee.update({
    where: { id: params.id },
    data: {
      ...parsed.data,
      hireDate: parsed.data.hireDate ? new Date(parsed.data.hireDate) : undefined,
    },
  });
  return NextResponse.json({ employee });
}

export async function DELETE(_req: NextRequest, { params }: { params: { id: string } }) {
  const session = await requireApiModule('employees');
  if (session instanceof NextResponse) return session;
  await prisma.employee.delete({ where: { id: params.id } });
  return NextResponse.json({ ok: true });
}
