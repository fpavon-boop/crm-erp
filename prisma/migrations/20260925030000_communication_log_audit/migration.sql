-- Phase 10 (Customer Communication): extends the existing CommunicationLog
-- table with the fields needed to make it a real outbound-message audit
-- trail — which template produced a message, whether the send actually
-- succeeded, the literal recipient address/number used, and an optional
-- link to the specific business record (Sales Order, Invoice, Quote, ...)
-- the message is about. See docs/CUSTOMER_COMMUNICATION.md.
--
-- Purely additive — five new nullable columns and one new index on an
-- existing table. No existing rows are touched; every pre-existing
-- CommunicationLog row simply has these new fields as NULL, which is
-- correct (they predate template-based, audited sending).

-- AlterTable
ALTER TABLE "CommunicationLog"
  ADD COLUMN "recipient" TEXT,
  ADD COLUMN "templateKey" TEXT,
  ADD COLUMN "status" TEXT,
  ADD COLUMN "relatedType" "RelatedEntityType",
  ADD COLUMN "relatedId" TEXT;

-- CreateIndex
CREATE INDEX "CommunicationLog_relatedType_relatedId_idx" ON "CommunicationLog"("relatedType", "relatedId");
