import { NextRequest, NextResponse } from 'next/server';
import bcrypt from 'bcryptjs';
import { prisma } from '@/lib/prisma';
import { requireApiModule } from '@/lib/api-auth';
import { userSchema } from '@/lib/validation';

export async function GET() {
  const session = await requireApiModule('users');
  if (session instanceof NextResponse) return session;

  const users = await prisma.user.findMany({
    select: { id: true, name: true, email: true, role: true, active: true, createdAt: true },
    orderBy: { name: 'asc' },
  });
  return NextResponse.json({ users });
}

export async function POST(req: NextRequest) {
  const session = await requireApiModule('users');
  if (session instanceof NextResponse) return session;
  if (session.user.role !== 'ADMIN') {
    return NextResponse.json({ error: 'Only admins can create users' }, { status: 403 });
  }

  const body = await req.json();
  const parsed = userSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  if (!parsed.data.password) {
    return NextResponse.json({ error: { formErrors: ['Password is required for new users'] } }, { status: 400 });
  }

  const passwordHash = await bcrypt.hash(parsed.data.password, 10);
  const user = await prisma.user.create({
    data: {
      name: parsed.data.name,
      email: parsed.data.email.toLowerCase(),
      role: parsed.data.role,
      passwordHash,
      active: parsed.data.active ?? true,
    },
    select: { id: true, name: true, email: true, role: true, active: true },
  });

  return NextResponse.json({ user }, { status: 201 });
}
