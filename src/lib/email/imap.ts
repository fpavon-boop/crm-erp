import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import { prisma } from '@/lib/prisma';
import { decryptSecret } from '@/lib/crypto';
import { saveUploadedFile } from '@/lib/uploads';

/**
 * Connects to one configured EmailAccount over IMAP, pulls messages received
 * since the last sync, stores them, and auto-links each message to a
 * matching Contact/Company by email address. Designed to be called from the
 * automations worker/cron (POST /api/automations/run) rather than on every
 * page load, since IMAP round trips are slow.
 */
export async function syncEmailAccount(accountId: string): Promise<{ fetched: number; linked: number }> {
  const account = await prisma.emailAccount.findUniqueOrThrow({ where: { id: accountId } });
  const password = decryptSecret(account.encryptedPassword);

  const client = new ImapFlow({
    host: account.imapHost,
    port: account.imapPort,
    secure: account.imapSecure,
    auth: { user: account.username, pass: password },
    logger: false,
  });

  let fetched = 0;
  let linked = 0;

  await client.connect();
  try {
    const lock = await client.getMailboxLock('INBOX');
    try {
      const since = account.lastSyncedAt ?? new Date(Date.now() - 1000 * 60 * 60 * 24 * 30);
      const searchResult = await client.search({ since });
      const uids = Array.isArray(searchResult) ? searchResult : [];

      for (const uid of uids) {
        const message = await client.fetchOne(String(uid), { source: true, uid: true });
        if (!message || !message.source) continue;

        const parsed = await simpleParser(message.source);
        const messageId = parsed.messageId || `uid-${uid}-${account.id}`;

        const exists = await prisma.emailMessage.findUnique({
          where: { emailAccountId_messageId: { emailAccountId: account.id, messageId } },
        });
        if (exists) continue;

        const fromAddress = parsed.from?.value?.[0]?.address || 'unknown@unknown';
        const toAddresses = (parsed.to && 'value' in parsed.to ? parsed.to.value : [])
          .map((t) => t.address)
          .filter(Boolean)
          .join(', ');

        const match = await findMatchingContactOrCompany(fromAddress);

        const created = await prisma.emailMessage.create({
          data: {
            emailAccountId: account.id,
            messageId,
            threadId: (parsed.references && parsed.references[0]) || messageId,
            direction: 'INBOUND',
            fromAddress,
            toAddresses,
            ccAddresses: parsed.cc && 'value' in parsed.cc ? parsed.cc.value.map((c) => c.address).join(', ') : null,
            subject: parsed.subject || '(no subject)',
            bodyText: parsed.text || null,
            bodyHtml: typeof parsed.html === 'string' ? parsed.html : null,
            companyId: match.companyId,
            contactId: match.contactId,
            receivedAt: parsed.date || new Date(),
          },
        });

        if (match.companyId || match.contactId) linked += 1;
        fetched += 1;

        for (const att of parsed.attachments || []) {
          const storedPath = await saveUploadedFile(
            'email-attachments',
            att.filename || 'attachment',
            att.content
          );
          await prisma.emailAttachment.create({
            data: {
              emailMessageId: created.id,
              filename: att.filename || 'attachment',
              storedPath,
              mimeType: att.contentType,
              size: att.size,
            },
          });
        }

        if (match.companyId || match.contactId) {
          await prisma.communicationLog.create({
            data: {
              type: 'EMAIL',
              direction: 'INBOUND',
              subject: parsed.subject || '(no subject)',
              body: parsed.text?.slice(0, 2000),
              companyId: match.companyId,
              contactId: match.contactId,
            },
          });
        }
      }
    } finally {
      lock.release();
    }
  } finally {
    await client.logout().catch(() => undefined);
  }

  await prisma.emailAccount.update({
    where: { id: account.id },
    data: { lastSyncedAt: new Date() },
  });

  return { fetched, linked };
}

async function findMatchingContactOrCompany(
  email: string
): Promise<{ companyId: string | null; contactId: string | null }> {
  const normalized = email.toLowerCase().trim();

  const contact = await prisma.contact.findFirst({
    where: { email: { equals: normalized, mode: 'insensitive' } },
  });
  if (contact) {
    return { companyId: contact.companyId, contactId: contact.id };
  }

  const companyEmail = await prisma.companyEmail.findFirst({
    where: { address: { equals: normalized, mode: 'insensitive' } },
  });
  if (companyEmail) {
    return { companyId: companyEmail.companyId, contactId: null };
  }

  // Fall back to matching by the sender's domain against company websites.
  const domain = normalized.split('@')[1];
  if (domain) {
    const company = await prisma.company.findFirst({
      where: { website: { contains: domain, mode: 'insensitive' } },
    });
    if (company) return { companyId: company.id, contactId: null };
  }

  return { companyId: null, contactId: null };
}
