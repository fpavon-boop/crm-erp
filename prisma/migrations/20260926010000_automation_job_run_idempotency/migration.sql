-- Phase 13 (automation system hardening): the standardized job-execution
-- contract (AutomationJobRun) and the shared idempotency-key primitive
-- (IdempotencyKey). See docs/AUTOMATION_SYSTEM.md.
--
-- Purely additive — two brand-new tables and one new enum. No existing
-- table/row is touched.

-- CreateEnum
CREATE TYPE "AutomationJobStatus" AS ENUM ('PENDING', 'RUNNING', 'COMPLETED', 'FAILED', 'RETRYING');

-- CreateTable
CREATE TABLE "AutomationJobRun" (
    "id" TEXT NOT NULL,
    "jobKey" TEXT NOT NULL,
    "trigger" TEXT NOT NULL,
    "conditions" JSONB,
    "action" TEXT,
    "status" "AutomationJobStatus" NOT NULL DEFAULT 'PENDING',
    "entityType" TEXT,
    "entityId" TEXT,
    "attempt" INTEGER NOT NULL DEFAULT 1,
    "maxAttempts" INTEGER NOT NULL DEFAULT 1,
    "errorMessage" TEXT,
    "errorStack" TEXT,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AutomationJobRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IdempotencyKey" (
    "key" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "resultRef" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "IdempotencyKey_pkey" PRIMARY KEY ("key")
);

-- CreateIndex
CREATE INDEX "AutomationJobRun_jobKey_status_idx" ON "AutomationJobRun"("jobKey", "status");

-- CreateIndex
CREATE INDEX "AutomationJobRun_status_createdAt_idx" ON "AutomationJobRun"("status", "createdAt");

-- CreateIndex
CREATE INDEX "IdempotencyKey_scope_idx" ON "IdempotencyKey"("scope");
