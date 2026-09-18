import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { requireApiModule } from '@/lib/api-auth';
import { encryptSecret } from '@/lib/crypto';
import { z } from 'zod';

const schema = z.object({
  label: z.string().min(1),
  phoneNumberId: z.string().min(1),
  businessAccountId: z.string().min(1),
  displayPhoneNumber: z.string().optional(),
  accessToken: z.string().min(1),
});

export async function GET() {
  const session = await requireApiModule('whatsapp');
  if (session instanceof NextResponse) return session;
  const accounts = await prisma.whatsAppAccount.findMany({
    select: { id: true, label: true, phoneNumberId: true, businessAccountId: true, displayPhoneNumber: true, active: true },
  });
  return NextResponse.json({ accounts });
}

export async function POST(req: NextRequest) {
  const session = await requireApiModule('whatsapp');
  if (session instanceof NextResponse) return session;
  if (session.user.role !== 'ADMIN') {
    return NextResponse.json({ error: 'Only admins can configure WhatsApp accounts' }, { status: 403 });
  }

  const body = await req.json();
  const parsed = schema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });

  const { accessToken, ...rest } = parsed.data;
  const account = await prisma.whatsAppAccount.create({
    data: { ...rest, encryptedAccessToken: encryptSecret(accessToken) },
    select: { id: true, label: true },
  });

  return NextResponse.json({ account }, { status: 201 });
}
