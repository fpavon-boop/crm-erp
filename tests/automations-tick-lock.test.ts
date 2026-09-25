import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { TestDb } from './test-db';
import { startTestDb } from './test-db';

/**
 * Phase 8 (SYSTEM_AUDIT.md D4): runAutomationsTickExclusive() is the one
 * entry point the in-process scheduler, the optional standalone worker,
 * and the manual/Cron-triggered route all share — it must guarantee that
 * two overlapping callers never both run a tick at the same time, and
 * that a stale/abandoned lease (a crashed process) can be reclaimed rather
 * than wedging automations forever. See src/lib/automations/tick-lock.ts.
 *
 * The real work a tick does (an automations pass + email sync) is fast
 * against this near-empty test database — fast enough that two calls
 * fired at the same JS-level instant can legitimately run one after the
 * other (claim -> work -> release, then claim again) rather than actually
 * overlapping in time, which correctly satisfies "never two ticks at
 * once" but doesn't exercise real contention deterministically. The
 * concurrency tests below pass an artificially slow `work` function (the
 * same injection seam runAutomationsTickExclusive() exposes for exactly
 * this purpose) to reliably force genuine overlap.
 */
describe('runAutomationsTickExclusive', () => {
  let db: TestDb;
  let runAutomationsTickExclusive: typeof import('../src/lib/automations/tick-lock')['runAutomationsTickExclusive'];

  beforeAll(async () => {
    db = await startTestDb();
    process.env.DATABASE_URL = db.url;
    const mod = await import('../src/lib/automations/tick-lock');
    runAutomationsTickExclusive = mod.runAutomationsTickExclusive;
  }, 60000);

  afterAll(async () => {
    await db.stop();
  });

  function sleep(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  // Long enough to comfortably outlast connection-pool queuing delay when
  // many calls compete for a database connection at once (observed to
  // matter specifically for the 8-way test below) — the whole point is to
  // guarantee every concurrent claim attempt is still in flight while the
  // winner holds the lease, not to rush the test.
  async function slowWork() {
    await sleep(500);
    return { results: { overdueInvoices: 0, pendingOrders: 0, lowStock: 0, unansweredEmails: 0 }, emailSync: [] };
  }

  it('a single call claims the lease and actually runs the tick', async () => {
    const result = await runAutomationsTickExclusive();
    expect(result.ranTick).toBe(true);
    expect(result.results).toBeDefined();
  });

  it('the lease is released after a successful run, so a later call can claim it again', async () => {
    const first = await runAutomationsTickExclusive();
    expect(first.ranTick).toBe(true);
    const second = await runAutomationsTickExclusive();
    expect(second.ranTick).toBe(true);
  });

  it('two calls that genuinely overlap in time: exactly one runs the tick, the other is a clean no-op (the core D4 regression test)', async () => {
    const [a, b] = await Promise.all([runAutomationsTickExclusive(slowWork), runAutomationsTickExclusive(slowWork)]);
    const ranCount = [a, b].filter((r) => r.ranTick).length;
    expect(ranCount).toBe(1);
    const skipped = [a, b].find((r) => !r.ranTick);
    expect(skipped).toBeDefined();
    expect(skipped?.results).toBeUndefined();
  });

  it('many overlapping calls: still exactly one ever runs at a time (no double-run under higher contention)', async () => {
    const results = await Promise.all(Array.from({ length: 8 }, () => runAutomationsTickExclusive(slowWork)));
    const ranCount = results.filter((r) => r.ranTick).length;
    expect(ranCount).toBe(1);
  });

  it('a stale (abandoned) lease can be reclaimed by a later call instead of wedging automations forever', async () => {
    // Simulate a process that claimed the lease and then crashed without
    // releasing it — directly write an old lockedAt, bypassing the normal
    // claim/release path.
    await db.prisma.scheduledTickLock.upsert({
      where: { id: 'automations-tick' },
      update: { lockedAt: new Date(Date.now() - 60 * 60 * 1000), runId: 'a-crashed-run' }, // 1 hour ago
      create: { id: 'automations-tick', lockedAt: new Date(Date.now() - 60 * 60 * 1000), runId: 'a-crashed-run' },
    });

    const result = await runAutomationsTickExclusive();
    expect(result.ranTick).toBe(true);
  });

  it('a fresh (non-stale) lease held by another run is NOT reclaimed', async () => {
    await db.prisma.scheduledTickLock.upsert({
      where: { id: 'automations-tick' },
      update: { lockedAt: new Date(), runId: 'currently-running' },
      create: { id: 'automations-tick', lockedAt: new Date(), runId: 'currently-running' },
    });

    const result = await runAutomationsTickExclusive();
    expect(result.ranTick).toBe(false);

    // Clean up so this doesn't leak into a later test in this file — the
    // lease is "free" when the row is absent, so this deletes it rather
    // than nulling fields.
    await db.prisma.scheduledTickLock.deleteMany({ where: { id: 'automations-tick' } });
  });

  it('sequential (non-overlapping) calls both succeed — the lock only prevents SIMULTANEOUS holders, not closely-spaced ones', async () => {
    const first = await runAutomationsTickExclusive();
    const second = await runAutomationsTickExclusive();
    expect(first.ranTick).toBe(true);
    expect(second.ranTick).toBe(true);
  });
});
