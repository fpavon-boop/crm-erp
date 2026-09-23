import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { TestDb } from './test-db';
import { startTestDb } from './test-db';

/** Item 5 (Phase 0), part 1: within handleInboundWebhook, one malformed
 * message in a batch must not silently block the rest, and its failure
 * must be recorded somewhere visible instead of only console output.
 * See docs/SYSTEM_AUDIT.md C3. */
describe('WhatsApp webhook: per-message error isolation', () => {
  let db: TestDb;
  let handleInboundWebhook: typeof import('../src/lib/whatsapp/client')['handleInboundWebhook'];

  beforeAll(async () => {
    db = await startTestDb();
    process.env.DATABASE_URL = db.url;
    process.env.IMAP_ENCRYPTION_KEY = '0'.repeat(64);
    const mod = await import('../src/lib/whatsapp/client');
    handleInboundWebhook = mod.handleInboundWebhook;
  }, 60000);

  afterAll(async () => {
    await db.stop();
  });

  function metaPayload(messages: unknown[]) {
    return {
      entry: [{ changes: [{ value: { metadata: { display_phone_number: '18604310505' }, messages } }] }],
    };
  }

  it('stores a normal message and reports it as stored, not failed', async () => {
    const result = await handleInboundWebhook(
      metaPayload([{ id: `wamid.${Math.random()}`, from: '19995551234', type: 'text', text: { body: 'hi' } }])
    );
    expect(result.stored).toBe(1);
    expect(result.failed).toBe(0);
  });

  it('one malformed message in a batch does not block the others, and is logged instead of silently dropped', async () => {
    const goodBefore = { id: `wamid.${Math.random()}`, from: '19995551111', type: 'text', text: { body: 'before' } };
    const malformed = { id: `wamid.${Math.random()}`, /* no `from` — required field, will fail to save */ type: 'text', text: { body: 'bad' } };
    const goodAfter = { id: `wamid.${Math.random()}`, from: '19995552222', type: 'text', text: { body: 'after' } };

    const result = await handleInboundWebhook(metaPayload([goodBefore, malformed, goodAfter]));

    // The two good messages either side of the bad one both made it in —
    // one bad message must not silently block the rest of the batch.
    expect(result.stored).toBe(2);
    expect(result.failed).toBe(1);

    const stored = await db.prisma.whatsAppMessage.findMany({
      where: { waMessageId: { in: [goodBefore.id, goodAfter.id] } },
    });
    expect(stored).toHaveLength(2);

    // The failure is visible somewhere real, not just console output.
    const logs = await db.prisma.automationLog.findMany({ where: { entityType: 'WHATSAPP_WEBHOOK', success: false } });
    expect(logs.length).toBeGreaterThanOrEqual(1);
    expect(logs.some((l) => l.entityId === malformed.id)).toBe(true);
  });

  it('a duplicate waMessageId is skipped quietly (not counted as failed)', async () => {
    const id = `wamid.${Math.random()}`;
    const first = await handleInboundWebhook(metaPayload([{ id, from: '19995553333', type: 'text', text: { body: 'x' } }]));
    expect(first.stored).toBe(1);

    const second = await handleInboundWebhook(metaPayload([{ id, from: '19995553333', type: 'text', text: { body: 'x' } }]));
    expect(second.stored).toBe(0);
    expect(second.failed).toBe(0);

    const all = await db.prisma.whatsAppMessage.findMany({ where: { waMessageId: id } });
    expect(all).toHaveLength(1);
  });
});
