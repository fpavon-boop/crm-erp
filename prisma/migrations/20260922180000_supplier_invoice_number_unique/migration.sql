-- Before running this migration against production, check for existing
-- duplicate SupplierInvoice.number values:
--
--   SELECT number, COUNT(*) FROM "SupplierInvoice" GROUP BY number HAVING COUNT(*) > 1;
--
-- If any rows are returned, rename the duplicates (or merge the records)
-- before deploying — Postgres will otherwise reject this migration outright
-- (a safe failure: nothing is applied, no data is lost) and the deploy will
-- stay stuck until it's fixed.

-- CreateIndex
CREATE UNIQUE INDEX "SupplierInvoice_number_key" ON "SupplierInvoice"("number");
