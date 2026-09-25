-- Phase 7 (Purchasing & Receiving): adds an optional, caller-supplied
-- idempotency key to GoodsReceipt so a duplicate goods-receipt submission
-- (double-click, network retry) can be detected and turned into a no-op
-- instead of creating a second receipt and double-incrementing inventory.
-- See docs/PURCHASING_AND_RECEIVING.md.
--
-- Purely additive: the column is nullable and every existing GoodsReceipt
-- row gets NULL, which Postgres never treats as a uniqueness conflict with
-- any other NULL (the same pattern already used for
-- Payment.stripePaymentIntentId in 20260924010000_stripe_integration) — no
-- pre-check query needed.

-- AlterTable
ALTER TABLE "GoodsReceipt" ADD COLUMN "idempotencyKey" TEXT;
CREATE UNIQUE INDEX "GoodsReceipt_idempotencyKey_key" ON "GoodsReceipt"("idempotencyKey");
