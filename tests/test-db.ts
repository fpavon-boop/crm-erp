/**
 * A throwaway, local-only Postgres instance for tests.
 *
 * This NEVER touches the production database: it starts a fresh,
 * temporary Postgres process on an unused local port, applies the real
 * `prisma/migrations/*` to it, and hands back a Prisma client whose
 * connection string points only at that temporary instance. There is no
 * code path here that reads `DATABASE_URL` from the environment, so even
 * if a production connection string were ever present in the shell, it
 * would be ignored.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import EmbeddedPostgres from 'embedded-postgres';
import { PrismaClient } from '@prisma/client';

const PORT = 55432 + Math.floor(Math.random() * 5000);

export interface TestDb {
  prisma: PrismaClient;
  url: string;
  stop: () => Promise<void>;
}

export async function startTestDb(): Promise<TestDb> {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'crm-erp-test-pg-'));
  const pg = new EmbeddedPostgres({
    databaseDir: dataDir,
    user: 'test',
    password: 'test',
    port: PORT,
    persistent: false,
    // Match production (postgres:16-alpine defaults to UTF8). Without this,
    // some platforms (observed on Windows) initialize the cluster with the
    // OS's codepage (e.g. WIN1252) instead, which can't store the non-Latin1
    // characters Prisma sometimes embeds in its own formatted error
    // messages — a test-environment-only artifact that has nothing to do
    // with the code under test.
    initdbFlags: ['--encoding=UTF8', '--locale=C'],
  });

  await pg.initialise();
  await pg.start();
  await pg.createDatabase('crm_test');

  const url = `postgresql://test:test@localhost:${PORT}/crm_test?schema=public`;

  // Apply the real migrations (the same files used in production) so the
  // test database's shape always matches what `prisma migrate deploy`
  // would produce there.
  execFileSync('npx', ['prisma@5.22.0', 'migrate', 'deploy'], {
    cwd: path.resolve(__dirname, '..'),
    env: { ...process.env, DATABASE_URL: url },
    stdio: 'pipe',
    shell: true,
  });

  const prisma = new PrismaClient({ datasources: { db: { url } } });
  await prisma.$connect();

  return {
    prisma,
    url,
    stop: async () => {
      await prisma.$disconnect();
      await pg.stop();
      rmSync(dataDir, { recursive: true, force: true });
    },
  };
}
