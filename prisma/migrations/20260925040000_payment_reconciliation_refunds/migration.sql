-- Phase 11 (SYSTEM_AUDIT.md L, K): WooCommerce paid-order -> Payment
-- reconciliation, and a distinct REFUNDED sales-order status separate from
-- CANCELLED. See docs/FINANCIAL_ACCURACY_AND_AUTOMATION.md.
--
-- Purely additive: two new nullable columns + one new unique index on
-- Payment, and one new enum value. No existing row is touched, and no
-- existing CANCELLED SalesOrder is retroactively reclassified — REFUNDED
-- only ever gets set going forward, by a future WooCommerce sync of an
-- order Woo itself reports as refunded.

-- AlterEnum
ALTER TYPE "SalesOrderStatus" ADD VALUE 'REFUNDED';

-- AlterTable
ALTER TABLE "Payment"
  ADD COLUMN "externalSource" TEXT,
  ADD COLUMN "externalId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "Payment_externalSource_externalId_key" ON "Payment"("externalSource", "externalId");
