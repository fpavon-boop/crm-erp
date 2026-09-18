import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { requireApiModule } from '@/lib/api-auth';
import { decryptSecret } from '@/lib/crypto';
import { getAccountTransport } from '@/lib/email/smtp';
import { z } from 'zod';

const schema = z.object({ body: z.string().min(1) });

/** Sends a human-reviewed reply through the connected mailbox's own SMTP
 * account (never auto-sent — the UI requires the user to edit/approve the
 * text first, per the "review and approve before sending" requirement). */
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const session = await requireApiModule('inbox');
  if (session instanceof NextResponse) return session;

  const body = await req.json();
  const parsed = schema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });

  const original = await prisma.emailMessage.findUnique({
    where: { id: params.id },
    include: { emailAccount: true },
  });
  if (!original) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const password = decryptSecret(original.emailAccount.encryptedPassword);
  const transport = getAccountTransport({
    smtpHost: original.emailAccount.smtpHost,
    smtpPort: original.emailAccount.smtpPort,
    smtpSecure: original.emailAccount.smtpSecure,
    username: original.emailAccount.username,
    password,
  });

  await transport.sendMail({
    from: original.emailAccount.emailAddress,
    to: original.fromAddress,
    subject: `Re: ${original.subject || ''}`,
    text: parsed.data.body,
    inReplyTo: original.messageId,
  });

  await prisma.emailMessage.create({
    data: {
      emailAccountId: original.emailAccountId,
      messageId: `reply-${Date.now()}-${original.id}`,
      threadId: original.threadId,
      direction: 'OUTBOUND',
      fromAddress: original.emailAccount.emailAddress,
      toAddresses: original.fromAddress,
      subject: `Re: ${original.subject || ''}`,
      bodyText: parsed.data.body,
      companyId: original.companyId,
      contactId: original.contactId,
      isRead: true,
      isAnswered: true,
    },
  });

  await prisma.emailMessage.update({ where: { id: original.id }, data: { isAnswered: true } });

  if (original.companyId || original.contactId) {
    await prisma.communicationLog.create({
      data: {
        type: 'EMAIL',
        direction: 'OUTBOUND',
        subject: `Re: ${original.subject || ''}`,
        body: parsed.data.body.slice(0, 2000),
        companyId: original.companyId,
        contactId: original.contactId,
        userId: session.user.id,
      },
    });
  }

  return NextResponse.json({ ok: true });
}
