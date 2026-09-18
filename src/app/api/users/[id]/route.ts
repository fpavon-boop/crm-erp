import { NextRequest, NextResponse } from 'next/server';
import bcrypt from 'bcryptjs';
import { prisma } from '@/lib/prisma';
import { requireApiModule } from '@/lib/api-auth';
import { userSchema } from '@/lib/validation';

export async function PUT(req: NextRequest, { params }: { params: { id: string } }) {
  const session = await requireApiModule('users');
  if (session instanceof NextResponse) return session;
  if (session.user.role !== 'ADMIN') {
    return NextResponse.json({ error: 'Only admins can edit users' }, { status: 403 });
  }

  const body = await req.json();
  const parsed = userSchema.partial().safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });

  const { password, ...rest } = parsed.data;
  const user = await prisma.user.update({
    where: { id: params.id },
    data: {
      ...rest,
      email: rest.email?.toLowerCase(),
      ...(password ? { passwordHash: await bcrypt.hash(password, 10) } : {}),
    },
    select: { id: true, name: true, email: true, role: true, active: true },
  });

  return NextResponse.json({ user });
}

export async function DELETE(_req: NextRequest, { params }: { params: { id: string } }) {
  const session = await requireApiModule('users');
  if (session instanceof NextResponse) return session;
  if (session.user.role !== 'ADMIN') {
    return NextResponse.json({ error: 'Only admins can delete users' }, { status: 403 });
  }
  if (session.user.id === params.id) {
    return NextResponse.json({ error: 'You cannot delete your own account' }, { status: 400 });
  }

  await prisma.user.delete({ where: { id: params.id } });
  return NextResponse.json({ ok: true });
}
