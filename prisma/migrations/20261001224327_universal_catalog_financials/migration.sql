-- CreateEnum
CREATE TYPE "CatalogCategoryGroup" AS ENUM ('OVEN', 'IRON_DOOR', 'REFRACTORY', 'ACCESSORY', 'TOOL', 'STAIN_ENHANCER', 'CUSTOM', 'OTHER');

-- CreateEnum
CREATE TYPE "ShippingMethod" AS ENUM ('PARCEL', 'LTL_FREIGHT');

-- CreateTable
CREATE TABLE "CatalogProduct" (
    "id" TEXT NOT NULL,
    "partNo" TEXT NOT NULL,
    "category" TEXT,
    "categoryGroup" "CatalogCategoryGroup" NOT NULL DEFAULT 'OTHER',
    "productName" TEXT NOT NULL,
    "description" TEXT,
    "pcsPerPallet" INTEGER,
    "weightLbs" DECIMAL(10,2),
    "dimensions" TEXT,
    "leadTimeDays" INTEGER,
    "acquisitionCost" DECIMAL(14,2) NOT NULL,
    "freightCost" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "importTaxesOrFees" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "packagingCost" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "shrinkageLossRate" DECIMAL(5,2) NOT NULL DEFAULT 0,
    "paymentProcessingFeeRate" DECIMAL(5,2) NOT NULL DEFAULT 2.9,
    "totalLandedCost" DECIMAL(14,2) NOT NULL,
    "markupDistributor" DECIMAL(5,2) NOT NULL DEFAULT 20,
    "markupContractor" DECIMAL(5,2) NOT NULL DEFAULT 30,
    "markupRetail" DECIMAL(5,2) NOT NULL DEFAULT 40,
    "distributorPriceOverride" DECIMAL(14,2),
    "contractorPriceOverride" DECIMAL(14,2),
    "retailPriceOverride" DECIMAL(14,2),
    "distributorPrice" DECIMAL(14,2) NOT NULL,
    "contractorPrice" DECIMAL(14,2) NOT NULL,
    "retailPrice" DECIMAL(14,2) NOT NULL,
    "netProfitDist" DECIMAL(14,2) NOT NULL,
    "netProfitCont" DECIMAL(14,2) NOT NULL,
    "netProfitRet" DECIMAL(14,2) NOT NULL,
    "trueMarginDist" DECIMAL(5,2) NOT NULL,
    "trueMarginCont" DECIMAL(5,2) NOT NULL,
    "trueMarginRet" DECIMAL(5,2) NOT NULL,
    "shippingMethod" "ShippingMethod" NOT NULL DEFAULT 'PARCEL',
    "freightClass" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CatalogProduct_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CatalogPriceAuditLog" (
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "oldCost" DECIMAL(14,2) NOT NULL,
    "newCost" DECIMAL(14,2) NOT NULL,
    "oldFreight" DECIMAL(14,2) NOT NULL,
    "newFreight" DECIMAL(14,2) NOT NULL,
    "triggerReason" TEXT,
    "changedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CatalogPriceAuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CatalogProduct_partNo_key" ON "CatalogProduct"("partNo");

-- CreateIndex
CREATE INDEX "CatalogProduct_category_idx" ON "CatalogProduct"("category");

-- CreateIndex
CREATE INDEX "CatalogProduct_categoryGroup_idx" ON "CatalogProduct"("categoryGroup");

-- CreateIndex
CREATE INDEX "CatalogProduct_isActive_idx" ON "CatalogProduct"("isActive");

-- CreateIndex
CREATE INDEX "CatalogPriceAuditLog_productId_idx" ON "CatalogPriceAuditLog"("productId");

-- AddForeignKey
ALTER TABLE "CatalogPriceAuditLog" ADD CONSTRAINT "CatalogPriceAuditLog_productId_fkey" FOREIGN KEY ("productId") REFERENCES "CatalogProduct"("id") ON DELETE CASCADE ON UPDATE CASCADE;
