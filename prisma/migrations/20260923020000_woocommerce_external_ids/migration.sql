-- Phase 2 (WooCommerce hardening): gives Product and ProductVariant the
-- same stable (externalSource, externalId) identity that Company, Contact,
-- and SalesOrder already have, so WooCommerce sync can match by the
-- WooCommerce product/variation id (which never changes) instead of only
-- by SKU (which can be renamed in WooCommerce, orphaning the old row).
--
-- Before running this migration against production, check for any
-- existing Product rows that would violate the new uniqueness (only
-- non-null pairs can conflict; NULLs are always distinct under a Postgres
-- unique index):
--
--   SELECT "externalSource", "externalId", COUNT(*)
--   FROM "Product"
--   WHERE "externalSource" IS NOT NULL AND "externalId" IS NOT NULL
--   GROUP BY "externalSource", "externalId"
--   HAVING COUNT(*) > 1;
--
-- If any rows are returned, they must be de-duplicated first — Postgres
-- will otherwise reject this migration outright (a safe failure: nothing
-- is applied, no data is lost) and the deploy will stay stuck until it's
-- fixed. ProductVariant has no existing externalSource/externalId data
-- (the columns are new), so no equivalent pre-check is needed for it.

-- DropIndex
DROP INDEX "Product_externalSource_externalId_idx";

-- CreateIndex (unique)
CREATE UNIQUE INDEX "Product_externalSource_externalId_key" ON "Product"("externalSource", "externalId");

-- AlterTable
ALTER TABLE "ProductVariant" ADD COLUMN "externalSource" TEXT;
ALTER TABLE "ProductVariant" ADD COLUMN "externalId" TEXT;

-- CreateIndex (unique)
CREATE UNIQUE INDEX "ProductVariant_externalSource_externalId_key" ON "ProductVariant"("externalSource", "externalId");
