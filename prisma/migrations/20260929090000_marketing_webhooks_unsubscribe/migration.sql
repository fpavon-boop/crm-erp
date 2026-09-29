-- Marketing Stage 11: brand postal address (CAN-SPAM), inbound webhook event
-- log (dedupe), and the marketing dispatcher lock. Additive, marketing tables only.

-- CreateEnum
CREATE TYPE "MarketingWebhookEventStatus" AS ENUM ('RECEIVED', 'PROCESSED', 'IGNORED', 'FAILED');

-- AlterTable
ALTER TABLE "MarketingBrandProfile" ADD COLUMN     "postalAddress" TEXT;

-- CreateTable
CREATE TABLE "MarketingWebhookEvent" (
    "id" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "jobId" TEXT,
    "status" "MarketingWebhookEventStatus" NOT NULL DEFAULT 'RECEIVED',
    "attempts" INTEGER NOT NULL DEFAULT 1,
    "outcome" JSONB,
    "error" TEXT,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMP(3),

    CONSTRAINT "MarketingWebhookEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MarketingLock" (
    "id" TEXT NOT NULL,
    "lockedAt" TIMESTAMP(3),
    "runId" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MarketingLock_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "MarketingWebhookEvent_jobId_idx" ON "MarketingWebhookEvent"("jobId");

-- CreateIndex
CREATE INDEX "MarketingWebhookEvent_status_receivedAt_idx" ON "MarketingWebhookEvent"("status", "receivedAt");

-- CreateIndex
CREATE UNIQUE INDEX "MarketingWebhookEvent_source_eventId_key" ON "MarketingWebhookEvent"("source", "eventId");

