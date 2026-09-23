-- Phase 4 (Stripe integration): adds the identifiers needed to reconcile
-- Stripe webhook events into existing Company/Payment records without
-- duplicating them, plus a dedicated table recording every Stripe event
-- id this app has processed — the idempotency guard against Stripe's
-- at-least-once webhook delivery. See docs/STRIPE_INTEGRATION.md.
--
-- All new columns are nullable and only ever set for Stripe-originated
-- records, so this is purely additive: existing Company and Payment rows
-- are unaffected, and there is nothing to check for conflicts before
-- applying it (no pre-check query needed — unlike prior migrations that
-- added a uniqueness constraint over data that could already have
-- duplicates, every uniqueness constraint here is on a brand-new nullable
-- column with no existing data).

-- AlterTable
ALTER TABLE "Company" ADD COLUMN "stripeCustomerId" TEXT;
CREATE UNIQUE INDEX "Company_stripeCustomerId_key" ON "Company"("stripeCustomerId");

-- AlterTable
ALTER TABLE "Payment" ADD COLUMN "stripePaymentIntentId" TEXT;
ALTER TABLE "Payment" ADD COLUMN "stripeChargeId" TEXT;
ALTER TABLE "Payment" ADD COLUMN "refundedAmount" DECIMAL(14,2) NOT NULL DEFAULT 0;
CREATE UNIQUE INDEX "Payment_stripePaymentIntentId_key" ON "Payment"("stripePaymentIntentId");

-- CreateTable
CREATE TABLE "StripeWebhookEvent" (
    "id" TEXT NOT NULL,
    "stripeEventId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "processedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "payload" JSONB,

    CONSTRAINT "StripeWebhookEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "StripeWebhookEvent_stripeEventId_key" ON "StripeWebhookEvent"("stripeEventId");
