-- Phase 1 inventory hardening: database-level backstops for two gaps
-- already closed at the application layer (see docs/INVENTORY_RULES.md).
--
-- These CHECK constraints add defense in depth only — they should never
-- actually fire in normal operation, since recordStockMovement() (floor at
-- zero) and receiveGoodsForPurchaseOrder() (over-receipt guard) already
-- prevent both conditions in application code. They exist so that any
-- future code path that writes to these tables directly, bypassing the
-- application layer, still cannot corrupt the data.
--
-- Before running this migration against production, check for any existing
-- rows that would violate either constraint:
--
--   SELECT id, "productVariantId", "warehouseId", quantity
--   FROM "StockLevel" WHERE quantity < 0;
--
--   SELECT id, "purchaseOrderId", quantity, "quantityReceived"
--   FROM "PurchaseOrderItem" WHERE "quantityReceived" > quantity;
--
-- If either query returns rows, they must be corrected (or the affected
-- rows investigated) before this migration can be applied — Postgres will
-- otherwise reject it outright (a safe failure: nothing is applied, no data
-- is lost) and the deploy will stay stuck until it's fixed.

-- CreateCheckConstraint
ALTER TABLE "StockLevel"
  ADD CONSTRAINT "StockLevel_quantity_nonnegative" CHECK (quantity >= 0);

-- CreateCheckConstraint
ALTER TABLE "PurchaseOrderItem"
  ADD CONSTRAINT "PurchaseOrderItem_quantityReceived_le_quantity" CHECK ("quantityReceived" <= quantity);
