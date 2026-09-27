import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { requireApiModule } from '@/lib/api-auth';
import { z } from 'zod';

export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  const session = await requireApiModule('inbox');
  if (session instanceof NextResponse) return session;

  const message = await prisma.emailMessage.findUnique({
    where: { id: params.id },
    include: {
      company: true,
      contact: true,
      attachments: true,
      // Never select encryptedPassword/imapHost/smtpHost/username — every
      // inbox-module user can look up any message, not just their own
      // mailbox's, so only non-credential fields belong here.
      emailAccount: { select: { id: true, label: true, emailAddress: true } },
    },
  });
  if (!message) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  if (!message.isRead) {
    await prisma.emailMessage.update({ where: { id: message.id }, data: { isRead: true } });
  }

  const thread = message.threadId
    ? await prisma.emailMessage.findMany({ where: { threadId: message.threadId }, orderBy: { receivedAt: 'asc' } })
    : [message];

  return NextResponse.json({ message, thread });
}

const patchSchema = z.object({
  isAnswered: z.boolean().optional(),
  isRead: z.boolean().optional(),
  companyId: z.string().optional().nullable(),
  contactId: z.string().optional().nullable(),
});

export async function PUT(req: NextRequest, { params }: { params: { id: string } }) {
  const session = await requireApiModule('inbox');
  if (session instanceof NextResponse) return session;

  const body = await req.json();
  const parsed = patchSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });

  const message = await prisma.emailMessage.update({ where: { id: params.id }, data: parsed.data });
  return NextResponse.json({ message });
}
