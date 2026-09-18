import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { requireApiModule } from '@/lib/api-auth';
import { encryptSecret } from '@/lib/crypto';
import { z } from 'zod';

const schema = z.object({
  label: z.string().min(1),
  emailAddress: z.string().email(),
  imapHost: z.string().min(1),
  imapPort: z.coerce.number().default(993),
  imapSecure: z.boolean().default(true),
  smtpHost: z.string().min(1),
  smtpPort: z.coerce.number().default(587),
  smtpSecure: z.boolean().default(false),
  username: z.string().min(1),
  password: z.string().min(1),
});

export async function GET() {
  const session = await requireApiModule('inbox');
  if (session instanceof NextResponse) return session;

  const accounts = await prisma.emailAccount.findMany({
    where: { userId: session.user.id },
    select: {
      id: true, label: true, emailAddress: true, imapHost: true, smtpHost: true, active: true, lastSyncedAt: true,
    },
  });
  return NextResponse.json({ accounts });
}

export async function POST(req: NextRequest) {
  const session = await requireApiModule('inbox');
  if (session instanceof NextResponse) return session;

  const body = await req.json();
  const parsed = schema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });

  const { password, ...rest } = parsed.data;
  const account = await prisma.emailAccount.create({
    data: { ...rest, userId: session.user.id, encryptedPassword: encryptSecret(password) },
    select: { id: true, label: true, emailAddress: true },
  });

  return NextResponse.json({ account }, { status: 201 });
}
