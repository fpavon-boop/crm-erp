import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { TestDb } from './test-db';
import { startTestDb } from './test-db';

describe('test harness smoke test', () => {
  let db: TestDb;

  beforeAll(async () => {
    db = await startTestDb();
  }, 60000);

  afterAll(async () => {
    await db.stop();
  });

  it('connects to a real, empty, migrated Postgres instance', async () => {
    const rows = await db.prisma.$queryRaw<{ one: number }[]>`SELECT 1 as one`;
    expect(rows[0].one).toBe(1);

    const userCount = await db.prisma.user.count();
    expect(userCount).toBe(0);
  });
});
