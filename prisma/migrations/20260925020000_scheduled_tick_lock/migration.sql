-- Phase 8: a brand-new table (ScheduledTickLock) used as a cross-process
-- lease/lock so the in-process scheduler, the optional standalone worker,
-- and the manual/Cron-triggered automations route can never run a tick at
-- the same time as each other (SYSTEM_AUDIT.md D4). See
-- src/lib/automations/tick-lock.ts.
--
-- Purely additive — a new table, no existing data affected, no pre-check
-- needed.

-- CreateTable
CREATE TABLE "ScheduledTickLock" (
    "id" TEXT NOT NULL,
    "lockedAt" TIMESTAMP(3),
    "runId" TEXT,

    CONSTRAINT "ScheduledTickLock_pkey" PRIMARY KEY ("id")
);
