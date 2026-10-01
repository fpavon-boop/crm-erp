-- CreateTable
CREATE TABLE "RefractoryProduct" (
    "id" TEXT NOT NULL,
    "partNo" TEXT NOT NULL,
    "category" TEXT,
    "productName" TEXT NOT NULL,
    "description" TEXT,
    "pcsPerPallet" INTEGER,
    "weightLbs" DECIMAL(10,2),
    "acquisitionCost" DECIMAL(14,2) NOT NULL,
    "freightCost" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "totalLandedCost" DECIMAL(14,2) NOT NULL,
    "distributorPrice" DECIMAL(14,2) NOT NULL,
    "contractorPrice" DECIMAL(14,2) NOT NULL,
    "retailPrice" DECIMAL(14,2) NOT NULL,
    "markupDistributor" DECIMAL(5,2) NOT NULL DEFAULT 20,
    "markupContractor" DECIMAL(5,2) NOT NULL DEFAULT 30,
    "markupRetail" DECIMAL(5,2) NOT NULL DEFAULT 40,
    "trueMarginDist" DECIMAL(5,2) NOT NULL,
    "trueMarginCont" DECIMAL(5,2) NOT NULL,
    "trueMarginRet" DECIMAL(5,2) NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RefractoryProduct_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RefractoryPriceAuditLog" (
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "oldCost" DECIMAL(14,2) NOT NULL,
    "newCost" DECIMAL(14,2) NOT NULL,
    "oldFreight" DECIMAL(14,2) NOT NULL,
    "newFreight" DECIMAL(14,2) NOT NULL,
    "triggerReason" TEXT,
    "changedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RefractoryPriceAuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "RefractoryProduct_partNo_key" ON "RefractoryProduct"("partNo");

-- CreateIndex
CREATE INDEX "RefractoryProduct_category_idx" ON "RefractoryProduct"("category");

-- CreateIndex
CREATE INDEX "RefractoryProduct_isActive_idx" ON "RefractoryProduct"("isActive");

-- CreateIndex
CREATE INDEX "RefractoryPriceAuditLog_productId_idx" ON "RefractoryPriceAuditLog"("productId");

-- AddForeignKey
ALTER TABLE "RefractoryPriceAuditLog" ADD CONSTRAINT "RefractoryPriceAuditLog_productId_fkey" FOREIGN KEY ("productId") REFERENCES "RefractoryProduct"("id") ON DELETE CASCADE ON UPDATE CASCADE;
