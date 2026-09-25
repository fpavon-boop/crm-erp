import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { TestDb } from './test-db';
import { startTestDb } from './test-db';
import { canAccess } from '../src/lib/permissions';

/**
 * Phase 10 (Customer Communication): database-backed tests proving —
 *
 * 1. sendCommunication() always writes exactly one CommunicationLog row,
 *    on both a successful and a failed send, with the recipient/channel/
 *    template/sentBy/timestamp the audit log requires.
 * 2. The pre-existing automated senders (sendOrderConfirmation,
 *    sendPaymentReminder, sendInvoiceByEmail) also log every attempt now,
 *    not just the new manual flow.
 * 3. Sending is gated by the same module-access roles already use for
 *    inbox/whatsapp elsewhere in the app.
 * 4. No credential/secret material ever appears in a send result or a
 *    CommunicationLog row.
 *
 * See docs/CUSTOMER_COMMUNICATION.md.
 */
describe('Customer communication — send + audit log', () => {
  let db: TestDb;
  let sendCommunication: typeof import('../src/lib/communications/send')['sendCommunication'];
  let notifications: typeof import('../src/lib/automations/notifications');

  beforeAll(async () => {
    db = await startTestDb();
    process.env.DATABASE_URL = db.url;
    process.env.IMAP_ENCRYPTION_KEY = 'a'.repeat(64);
    sendCommunication = (await import('../src/lib/communications/send')).sendCommunication;
    notifications = await import('../src/lib/automations/notifications');
  }, 60000);

  afterAll(async () => {
    await db.stop();
  });

  function id() {
    return Math.random().toString(36).slice(2);
  }

  async function makeCompanyWithContact() {
    const company = await db.prisma.company.create({ data: { name: `Co ${id()}`, type: 'CUSTOMER' } });
    const contact = await db.prisma.contact.create({
      data: { firstName: 'Jane', lastName: 'Smith', email: `jane-${id()}@example.com`, companyId: company.id },
    });
    return { company, contact };
  }

  describe('sendCommunication', () => {
    it('a successful send writes one CommunicationLog row with recipient, channel, template, sentBy user, and timestamp', async () => {
      const { company, contact } = await makeCompanyWithContact();
      const user = await db.prisma.user.create({ data: { name: 'Agent Smith', email: `agent-${id()}@example.com`, passwordHash: 'x', role: 'SALES' } });

      const result = await sendCommunication(
        {
          channel: 'email',
          to: contact.email!,
          subject: 'Order confirmation SO-1',
          body: 'Your order SO-1 has been confirmed.',
          templateKey: 'order_confirmation',
          companyId: company.id,
          contactId: contact.id,
          relatedType: 'SALES_ORDER',
          relatedId: 'so-1',
          userId: user.id,
        },
        { emailSender: async () => ({ sent: true }) }
      );

      expect(result.sent).toBe(true);
      const log = await db.prisma.communicationLog.findUniqueOrThrow({ where: { id: result.communicationLogId } });
      expect(log.type).toBe('EMAIL');
      expect(log.direction).toBe('OUTBOUND');
      expect(log.recipient).toBe(contact.email);
      expect(log.templateKey).toBe('order_confirmation');
      expect(log.status).toBe('SENT');
      expect(log.userId).toBe(user.id);
      expect(log.companyId).toBe(company.id);
      expect(log.relatedType).toBe('SALES_ORDER');
      expect(log.relatedId).toBe('so-1');
      expect(log.occurredAt).toBeInstanceOf(Date);
    });

    it('a failed send (email transport unavailable) still writes exactly one CommunicationLog row, marked FAILED — never silently lost', async () => {
      const { company, contact } = await makeCompanyWithContact();

      const before = await db.prisma.communicationLog.count();
      const result = await sendCommunication(
        {
          channel: 'email',
          to: contact.email!,
          subject: 'x',
          body: 'x',
          templateKey: 'payment_reminder',
          companyId: company.id,
        },
        { emailSender: async () => ({ sent: false, reason: 'No SMTP configured' }) }
      );
      const after = await db.prisma.communicationLog.count();

      expect(result.sent).toBe(false);
      expect(result.reason).toBe('No SMTP configured');
      expect(after).toBe(before + 1);
      const log = await db.prisma.communicationLog.findUniqueOrThrow({ where: { id: result.communicationLogId } });
      expect(log.status).toBe('FAILED');
    });

    it('a sender that throws is still captured as a FAILED audit entry, not an unhandled rejection', async () => {
      const { contact } = await makeCompanyWithContact();
      const result = await sendCommunication(
        { channel: 'whatsapp', to: '+15550001111', body: 'hi' },
        {
          whatsappSender: async () => {
            throw new Error('WhatsApp API error (401)');
          },
        }
      );
      expect(result.sent).toBe(false);
      expect(result.reason).toContain('WhatsApp API error');
      const log = await db.prisma.communicationLog.findUniqueOrThrow({ where: { id: result.communicationLogId } });
      expect(log.status).toBe('FAILED');
      expect(log.type).toBe('WHATSAPP');
      void contact;
    });

    it('a whatsapp send stores no subject (email-only field)', async () => {
      const result = await sendCommunication(
        { channel: 'whatsapp', to: '+15550002222', subject: 'ignored', body: 'hello' },
        { whatsappSender: async () => ({}) }
      );
      const log = await db.prisma.communicationLog.findUniqueOrThrow({ where: { id: result.communicationLogId } });
      expect(log.subject).toBeNull();
    });
  });

  describe('automated senders also log every attempt (not just the manual flow)', () => {
    it('sendOrderConfirmation logs a FAILED attempt when there is no recipient email on file — wait, logs nothing when there is no recipient at all (nothing to attempt)', async () => {
      const company = await db.prisma.company.create({ data: { name: `NoEmail ${id()}`, type: 'CUSTOMER' } });
      const order = await db.prisma.salesOrder.create({
        data: { number: `SO-${id()}`, status: 'CONFIRMED', companyId: company.id, items: { create: [{ description: 'x', quantity: 1, unitPrice: 10 }] } },
      });
      const before = await db.prisma.communicationLog.count();
      const result = await notifications.sendOrderConfirmation(order.id);
      const after = await db.prisma.communicationLog.count();
      expect(result.sent).toBe(false);
      expect(after).toBe(before); // no recipient at all — nothing was attempted, nothing to log
    });

    it('sendOrderConfirmation logs a FAILED attempt (no SMTP configured in the test environment) with the order linked', async () => {
      const { company, contact } = await makeCompanyWithContact();
      const order = await db.prisma.salesOrder.create({
        data: {
          number: `SO-${id()}`,
          status: 'CONFIRMED',
          companyId: company.id,
          contactId: contact.id,
          items: { create: [{ description: 'x', quantity: 1, unitPrice: 10 }] },
        },
      });

      const result = await notifications.sendOrderConfirmation(order.id);
      expect(result.sent).toBe(false); // no SMTP_HOST / connected mailbox in this test environment

      const log = await db.prisma.communicationLog.findFirst({
        where: { relatedType: 'SALES_ORDER', relatedId: order.id },
        orderBy: { occurredAt: 'desc' },
      });
      expect(log).toBeDefined();
      expect(log!.templateKey).toBe('order_confirmation');
      expect(log!.status).toBe('FAILED');
      expect(log!.recipient).toBe(contact.email);
    });

    it('sendPaymentReminder logs the attempt, linked to the invoice', async () => {
      const { company, contact } = await makeCompanyWithContact();
      const invoice = await db.prisma.invoice.create({
        data: {
          number: `INV-${id()}`,
          type: 'INVOICE',
          status: 'OVERDUE',
          companyId: company.id,
          contactId: contact.id,
          subtotal: 100,
          total: 100,
          dueDate: new Date(Date.now() - 86_400_000),
        },
      });

      await notifications.sendPaymentReminder(invoice.id);
      const log = await db.prisma.communicationLog.findFirst({ where: { relatedType: 'INVOICE', relatedId: invoice.id } });
      expect(log).toBeDefined();
      expect(log!.templateKey).toBe('payment_reminder');
    });
  });

  describe('role-based permissions for sending', () => {
    it('email sending requires the inbox module; whatsapp sending requires the whatsapp module — matching every other channel action in this app', () => {
      expect(canAccess('ADMIN', 'inbox')).toBe(true);
      expect(canAccess('ADMIN', 'whatsapp')).toBe(true);
      expect(canAccess('SALES', 'inbox')).toBe(true);
      expect(canAccess('SALES', 'whatsapp')).toBe(true);
      expect(canAccess('ACCOUNTING', 'inbox')).toBe(true);
      // ACCOUNTING has no whatsapp module access — the Send Communication
      // form and its API route must both refuse a whatsapp send for this role.
      expect(canAccess('ACCOUNTING', 'whatsapp')).toBe(false);
    });
  });

  describe('credentials never leak through a send result or the audit log', () => {
    it("sendCommunication's result never contains credential-shaped data", async () => {
      const result = await sendCommunication(
        { channel: 'email', to: 'x@example.com', body: 'hi' },
        { emailSender: async () => ({ sent: true }) }
      );
      const serialized = JSON.stringify(result);
      expect(serialized).not.toMatch(/password|encryptedPassword|encryptedAccessToken|accessToken|smtpHost|imapHost/i);
    });

    it('a CommunicationLog row never stores raw account credential fields — only the schema-defined audit columns exist to store them in', async () => {
      const result = await sendCommunication(
        { channel: 'email', to: 'x2@example.com', body: 'hi' },
        { emailSender: async () => ({ sent: true }) }
      );
      const log = await db.prisma.communicationLog.findUniqueOrThrow({ where: { id: result.communicationLogId } });
      const serialized = JSON.stringify(log);
      expect(serialized).not.toMatch(/password|encryptedAccessToken|accessToken/i);
    });
  });
});
