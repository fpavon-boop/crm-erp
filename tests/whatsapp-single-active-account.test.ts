import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { TestDb } from './test-db';
import { startTestDb } from './test-db';

/** Item 2 (Phase 0): at most one WhatsAppAccount can be active at a time,
 * both at the database level (migration
 * 20260922180500_whatsapp_account_single_active) and via the application
 * helpers that switch which account is active. */
describe('Single active WhatsApp account', () => {
  let db: TestDb;
  let createActiveWhatsAppAccount: typeof import('../src/lib/whatsapp/accounts')['createActiveWhatsAppAccount'];
  let activateWhatsAppAccount: typeof import('../src/lib/whatsapp/accounts')['activateWhatsAppAccount'];
  let WhatsAppAccountActivationRaceError: typeof import('../src/lib/whatsapp/accounts')['WhatsAppAccountActivationRaceError'];

  beforeAll(async () => {
    db = await startTestDb();
    process.env.DATABASE_URL = db.url;
    process.env.IMAP_ENCRYPTION_KEY = '0'.repeat(64);
    const mod = await import('../src/lib/whatsapp/accounts');
    createActiveWhatsAppAccount = mod.createActiveWhatsAppAccount;
    activateWhatsAppAccount = mod.activateWhatsAppAccount;
    WhatsAppAccountActivationRaceError = mod.WhatsAppAccountActivationRaceError;
  }, 60000);

  afterAll(async () => {
    await db.stop();
  });

  async function activeAccounts() {
    return db.prisma.whatsAppAccount.findMany({ where: { active: true } });
  }

  it('the database itself rejects a second row with active = true', async () => {
    await db.prisma.whatsAppAccount.create({
      data: { label: 'A', phoneNumberId: '1', businessAccountId: 'b1', encryptedAccessToken: 'x', active: true },
    });
    await expect(
      db.prisma.whatsAppAccount.create({
        data: { label: 'B', phoneNumberId: '2', businessAccountId: 'b2', encryptedAccessToken: 'y', active: true },
      })
    ).rejects.toMatchObject({ code: 'P2002' });

    // A row with active: false is still fine alongside the active one.
    await expect(
      db.prisma.whatsAppAccount.create({
        data: { label: 'C', phoneNumberId: '3', businessAccountId: 'b3', encryptedAccessToken: 'z', active: false },
      })
    ).resolves.toBeTruthy();
  });

  it('createActiveWhatsAppAccount deactivates the previous account', async () => {
    const first = await createActiveWhatsAppAccount({
      label: 'First number', phoneNumberId: 'p1', businessAccountId: 'ba1', encryptedAccessToken: 'tok1',
    });
    expect(first.active).toBe(true);

    const second = await createActiveWhatsAppAccount({
      label: 'Second number', phoneNumberId: 'p2', businessAccountId: 'ba2', encryptedAccessToken: 'tok2',
    });
    expect(second.active).toBe(true);

    const active = await activeAccounts();
    expect(active).toHaveLength(1);
    expect(active[0].id).toBe(second.id);

    const reloadedFirst = await db.prisma.whatsAppAccount.findUnique({ where: { id: first.id } });
    expect(reloadedFirst?.active).toBe(false);
  });

  it('activateWhatsAppAccount switches which account is active', async () => {
    const a = await createActiveWhatsAppAccount({ label: 'A2', phoneNumberId: 'pa2', businessAccountId: 'baA2', encryptedAccessToken: 't' });
    const b = await createActiveWhatsAppAccount({ label: 'B2', phoneNumberId: 'pb2', businessAccountId: 'baB2', encryptedAccessToken: 't' });
    // b is active now (created after a). Switch back to a.
    await activateWhatsAppAccount(a.id);

    const active = await activeAccounts();
    expect(active).toHaveLength(1);
    expect(active[0].id).toBe(a.id);

    const reloadedB = await db.prisma.whatsAppAccount.findUnique({ where: { id: b.id } });
    expect(reloadedB?.active).toBe(false);
  });

  it('never ends up with two active accounts even when two activations race', async () => {
    const a = await createActiveWhatsAppAccount({ label: 'RaceA', phoneNumberId: 'ra', businessAccountId: 'raba', encryptedAccessToken: 't' });
    const b = await createActiveWhatsAppAccount({ label: 'RaceB', phoneNumberId: 'rb', businessAccountId: 'rbba', encryptedAccessToken: 't' });

    // Fire two concurrent activations for the two different accounts.
    const results = await Promise.allSettled([activateWhatsAppAccount(a.id), activateWhatsAppAccount(b.id)]);
    // Both may succeed sequentially (last one wins) or one may lose to the
    // unique index race — either is acceptable. What must never happen is
    // ending up with more than one active account.
    for (const r of results) {
      if (r.status === 'rejected') {
        expect(r.reason).toBeInstanceOf(WhatsAppAccountActivationRaceError);
      }
    }

    const active = await activeAccounts();
    expect(active.length).toBeLessThanOrEqual(1);
  });
});
