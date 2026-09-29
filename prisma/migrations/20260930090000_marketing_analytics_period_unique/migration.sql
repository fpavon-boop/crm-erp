-- Marketing Phase 12: one analytics row per post per period. Additive index only.

-- CreateIndex
CREATE UNIQUE INDEX "MarketingAnalytics_socialPostId_periodStart_periodEnd_key" ON "MarketingAnalytics"("socialPostId", "periodStart", "periodEnd");

