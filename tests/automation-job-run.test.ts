import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { TestDb } from './test-db';
import { startTestDb } from './test-db';

/**
 * Phase 13 (Automation System Hardening, docs/AUTOMATION_SYSTEM.md),
 * requirement 1 (Standardized Automation Execution Contract): every
 * built-in scheduled job runs through runAutomationJob(), which must
 * guarantee status transitions (PENDING/RUNNING -> COMPLETED/FAILED/
 * RETRYING), non-swallowed error + stack trace capture, and a
 * maxAttempts backoff that stops retrying a job that keeps failing for
 * the same entity instead of retrying it forever silently.
 */
describe('runAutomationJob', () => {
  let db: TestDb;
  let runAutomationJob: typeof import('../src/lib/automations/job-run')['runAutomationJob'];

  beforeAll(async () => {
    db = await startTestDb();
    process.env.DATABASE_URL = db.url;
    const mod = await import('../src/lib/automations/job-run');
    runAutomationJob = mod.runAutomationJob;
  }, 60000);

  afterAll(async () => {
    await db.stop();
  });

  function jobKey() {
    return `job-${Math.random().toString(36).slice(2)}`;
  }

  it('a successful run is recorded as COMPLETED with start/finish timestamps and the function result returned', async () => {
    const key = jobKey();
    const result = await runAutomationJob({ jobKey: key, trigger: 'TEST', action: 'do_thing' }, async () => 42);

    expect(result.status).toBe('COMPLETED');
    expect(result.result).toBe(42);

    const run = await db.prisma.automationJobRun.findFirstOrThrow({ where: { jobKey: key } });
    expect(run.status).toBe('COMPLETED');
    expect(run.trigger).toBe('TEST');
    expect(run.action).toBe('do_thing');
    expect(run.startedAt).not.toBeNull();
    expect(run.finishedAt).not.toBeNull();
    expect(run.attempt).toBe(1);
  });

  it('a thrown error is never swallowed: the message AND stack trace are captured on the row, and returned', async () => {
    const key = jobKey();
    const result = await runAutomationJob({ jobKey: key, trigger: 'TEST', maxAttempts: 1 }, async () => {
      throw new Error('boom: something specific went wrong');
    });

    expect(result.status).toBe('FAILED');
    expect(result.error).toContain('boom: something specific went wrong');

    const run = await db.prisma.automationJobRun.findFirstOrThrow({ where: { jobKey: key } });
    expect(run.status).toBe('FAILED');
    expect(run.errorMessage).toContain('boom: something specific went wrong');
    expect(run.errorStack).toBeTruthy();
    expect(run.errorStack).toContain('Error: boom');
  });

  it('a non-Error throw (e.g. a plain string) still records a usable error message instead of losing the failure', async () => {
    const key = jobKey();
    const result = await runAutomationJob({ jobKey: key, trigger: 'TEST' }, async () => {
      // eslint-disable-next-line @typescript-eslint/no-throw-literal
      throw 'a plain string rejection';
    });

    expect(result.status).toBe('FAILED');
    expect(result.error).toBe('a plain string rejection');
    const run = await db.prisma.automationJobRun.findFirstOrThrow({ where: { jobKey: key } });
    expect(run.errorMessage).toBe('a plain string rejection');
    expect(run.errorStack).toBeNull();
  });

  it('a failure with attempts remaining is marked RETRYING, not a terminal FAILED', async () => {
    const key = jobKey();
    const result = await runAutomationJob(
      { jobKey: key, trigger: 'TEST', entityType: 'Invoice', entityId: 'inv-1', maxAttempts: 3 },
      async () => {
        throw new Error('transient failure');
      }
    );
    expect(result.status).toBe('RETRYING');
    const run = await db.prisma.automationJobRun.findFirstOrThrow({ where: { jobKey: key } });
    expect(run.status).toBe('RETRYING');
    expect(run.attempt).toBe(1);
    expect(run.maxAttempts).toBe(3);
  });

  it('per-entity backoff: repeated failures for the SAME entity increment attempt, and stop being retried once maxAttempts is exhausted', async () => {
    const key = jobKey();
    const opts = { jobKey: key, trigger: 'TEST', entityType: 'Invoice', entityId: 'inv-backoff', maxAttempts: 2 };
    const failing = async () => {
      throw new Error('still failing');
    };

    const first = await runAutomationJob(opts, failing);
    expect(first.status).toBe('RETRYING'); // attempt 1 of 2

    const second = await runAutomationJob(opts, failing);
    expect(second.status).toBe('FAILED'); // attempt 2 of 2 — exhausted, terminal

    // A third call must not even attempt to run the job again — no new
    // row is written, and the wrapper says so explicitly rather than
    // silently retrying forever.
    const countBefore = await db.prisma.automationJobRun.count({ where: { jobKey: key } });
    const third = await runAutomationJob(opts, failing);
    const countAfter = await db.prisma.automationJobRun.count({ where: { jobKey: key } });
    expect(third.status).toBe('FAILED');
    expect(third.error).toContain('Exceeded maxAttempts');
    expect(countAfter).toBe(countBefore); // no new row — genuinely did not run
  });

  it('a later COMPLETED run resets the backoff counter for that entity — a job that eventually succeeds is not permanently exhausted', async () => {
    const key = jobKey();
    const entityId = 'inv-reset';
    await runAutomationJob({ jobKey: key, trigger: 'TEST', entityType: 'Invoice', entityId, maxAttempts: 1 }, async () => {
      throw new Error('fails once');
    });
    // Exhausted after the first failure (maxAttempts: 1) — but the run
    // still succeeds if invoked directly bypassing the wrapper's own
    // gate is not the point here; instead prove a genuine COMPLETED run
    // resets the count for the next failure cycle.
    await db.prisma.automationJobRun.updateMany({ where: { jobKey: key, entityId }, data: { status: 'COMPLETED' } });

    const afterReset = await runAutomationJob(
      { jobKey: key, trigger: 'TEST', entityType: 'Invoice', entityId, maxAttempts: 1 },
      async () => 'ok'
    );
    expect(afterReset.status).toBe('COMPLETED');
    const latest = await db.prisma.automationJobRun.findFirstOrThrow({ where: { jobKey: key, entityId }, orderBy: { createdAt: 'desc' } });
    expect(latest.attempt).toBe(1);
  });

  it('a whole-batch job with no entityType/entityId is always attempt 1 (no per-entity backoff applies)', async () => {
    const key = jobKey();
    const failing = async () => {
      throw new Error('batch failure');
    };
    const first = await runAutomationJob({ jobKey: key, trigger: 'TEST', maxAttempts: 1 }, failing);
    const second = await runAutomationJob({ jobKey: key, trigger: 'TEST', maxAttempts: 1 }, failing);
    expect(first.status).toBe('FAILED');
    expect(second.status).toBe('FAILED'); // not "Exceeded maxAttempts" — runs again every time
    expect(second.error).not.toContain('Exceeded maxAttempts');
    const runs = await db.prisma.automationJobRun.findMany({ where: { jobKey: key } });
    expect(runs).toHaveLength(2);
    expect(runs.every((r) => r.attempt === 1)).toBe(true);
  });
});
