import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { TestDb } from './test-db';
import { startTestDb } from './test-db';

/**
 * Phase 13 (Automation System Hardening, docs/AUTOMATION_SYSTEM.md): the
 * shared IdempotencyKey primitive every idempotent call site in the app
 * (manual sends, payment reminders, order confirmations, manual payment
 * recording, manual inventory adjustments, Company/Contact creation) is
 * built on. The whole guarantee — "repeated execution with the same key
 * is a safe no-op" — rests on this one module, so it gets its own
 * dedicated, thorough test file rather than being exercised only
 * incidentally through higher-level call sites.
 */
describe('claimIdempotencyKey / recordIdempotentResult', () => {
  let db: TestDb;
  let claimIdempotencyKey: typeof import('../src/lib/automations/idempotency')['claimIdempotencyKey'];
  let recordIdempotentResult: typeof import('../src/lib/automations/idempotency')['recordIdempotentResult'];

  beforeAll(async () => {
    db = await startTestDb();
    process.env.DATABASE_URL = db.url;
    const mod = await import('../src/lib/automations/idempotency');
    claimIdempotencyKey = mod.claimIdempotencyKey;
    recordIdempotentResult = mod.recordIdempotentResult;
  }, 60000);

  afterAll(async () => {
    await db.stop();
  });

  function key() {
    return `key-${Math.random().toString(36).slice(2)}`;
  }

  it('a brand-new key is claimed, with no prior result', async () => {
    const claim = await claimIdempotencyKey(key(), 'test_scope');
    expect(claim.claimed).toBe(true);
    expect(claim.existingResultRef).toBeNull();
  });

  it('claiming the same key twice: the first call wins, the second is told it lost and gets no result yet', async () => {
    const k = key();
    const first = await claimIdempotencyKey(k, 'test_scope');
    const second = await claimIdempotencyKey(k, 'test_scope');
    expect(first.claimed).toBe(true);
    expect(second.claimed).toBe(false);
    expect(second.existingResultRef).toBeNull(); // winner hasn't recorded a result yet
  });

  it('recordIdempotentResult attaches a result that a later duplicate claim can read back', async () => {
    const k = key();
    await claimIdempotencyKey(k, 'test_scope');
    await recordIdempotentResult(k, 'some-entity-id-123');

    const duplicate = await claimIdempotencyKey(k, 'test_scope');
    expect(duplicate.claimed).toBe(false);
    expect(duplicate.existingResultRef).toBe('some-entity-id-123');
  });

  it('the same literal key string is a genuine collision even across different scopes — the key itself, not (key, scope), is the unique identity', async () => {
    const k = key();
    const first = await claimIdempotencyKey(k, 'scope_a');
    const second = await claimIdempotencyKey(k, 'scope_b');
    expect(first.claimed).toBe(true);
    expect(second.claimed).toBe(false);
  });

  it('two different keys never collide, even in the same scope', async () => {
    const a = await claimIdempotencyKey(key(), 'test_scope');
    const b = await claimIdempotencyKey(key(), 'test_scope');
    expect(a.claimed).toBe(true);
    expect(b.claimed).toBe(true);
  });

  it('concurrent claims of the same key: exactly one wins, no matter how many race (the core guarantee under real contention)', async () => {
    const k = key();
    const results = await Promise.all(Array.from({ length: 10 }, () => claimIdempotencyKey(k, 'test_scope')));
    const wins = results.filter((r) => r.claimed).length;
    expect(wins).toBe(1);
  });

  it('recordIdempotentResult on a key that was never claimed is a harmless no-op (defensive — should never happen in practice)', async () => {
    await expect(recordIdempotentResult(key(), 'ref')).resolves.toBeUndefined();
  });
});
