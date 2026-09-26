-- Phase 14 (AI-Assisted Features): the audit log for every AI generation
-- call. See docs/AI_FEATURES.md.
--
-- Purely additive — one new enum and one new table. No existing table/row
-- is touched.

CREATE TYPE "AiFeature" AS ENUM ('CUSTOMER_SUMMARY', 'SALES_SUMMARY', 'EMAIL_DRAFT', 'FOLLOWUP_SUGGESTIONS', 'PRODUCT_ANALYSIS', 'INVENTORY_WARNING', 'INVOICE_SUMMARY');

CREATE TABLE "AiGenerationLog" (
    "id" TEXT NOT NULL,
    "feature" "AiFeature" NOT NULL,
    "entityType" TEXT,
    "entityId" TEXT,
    "requestedById" TEXT,
    "companyId" TEXT,
    "model" TEXT,
    "status" TEXT NOT NULL,
    "errorMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AiGenerationLog_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "AiGenerationLog_feature_createdAt_idx" ON "AiGenerationLog"("feature", "createdAt");
CREATE INDEX "AiGenerationLog_entityType_entityId_idx" ON "AiGenerationLog"("entityType", "entityId");

ALTER TABLE "AiGenerationLog" ADD CONSTRAINT "AiGenerationLog_requestedById_fkey" FOREIGN KEY ("requestedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "AiGenerationLog" ADD CONSTRAINT "AiGenerationLog_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE SET NULL ON UPDATE CASCADE;
