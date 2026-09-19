import nodemailer from 'nodemailer';
import { prisma } from '@/lib/prisma';
import { decryptSecret } from '@/lib/crypto';

/** Default outbound transport, configured from env (SMTP_*). Used for system
 * notifications: invoice delivery, payment reminders, order confirmations. */
export function getSystemTransport() {
  const host = process.env.SMTP_HOST;
  const port = Number(process.env.SMTP_PORT || 587);
  const secure = process.env.SMTP_SECURE === 'true';
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASSWORD;

  if (!host || !user || !pass) {
    return null;
  }

  return nodemailer.createTransport({
    host,
    port,
    secure,
    auth: { user, pass },
  });
}

export async function sendSystemEmail(opts: {
  to: string;
  subject: string;
  html: string;
  attachments?: { filename: string; content: Buffer }[];
}): Promise<{ sent: boolean; reason?: string }> {
  let transport = getSystemTransport();
  let from = process.env.SMTP_FROM || process.env.SMTP_USER;

  if (!transport) {
    // Fall back to the first connected mailbox so no separate SMTP_* setup is needed.
    const account = await prisma.emailAccount.findFirst({ where: { active: true }, orderBy: { createdAt: 'asc' } });
    if (!account) {
      return { sent: false, reason: 'No SMTP configured and no connected mailbox (Email Inbox > Manage Accounts)' };
    }
    transport = getAccountTransport({
      smtpHost: account.smtpHost,
      smtpPort: account.smtpPort,
      smtpSecure: account.smtpSecure,
      username: account.username,
      password: decryptSecret(account.encryptedPassword),
    });
    from = account.emailAddress;
  }

  await transport.sendMail({
    from,
    to: opts.to,
    subject: opts.subject,
    html: opts.html,
    attachments: opts.attachments,
  });
  return { sent: true };
}

/** Builds a transport for a user-connected mailbox (per EmailAccount row). */
export function getAccountTransport(account: {
  smtpHost: string;
  smtpPort: number;
  smtpSecure: boolean;
  username: string;
  password: string;
}) {
  return nodemailer.createTransport({
    host: account.smtpHost,
    port: account.smtpPort,
    secure: account.smtpSecure,
    auth: { user: account.username, pass: account.password },
  });
}
