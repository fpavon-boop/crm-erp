-- CreateEnum
CREATE TYPE "SalesChannel" AS ENUM ('WOOCOMMERCE', 'AMAZON', 'WALMART', 'TIKTOK_SHOP');

-- CreateTable
CREATE TABLE "ChannelReference" (
    "id" TEXT NOT NULL,
    "channel" "SalesChannel" NOT NULL,
    "entityType" "RelatedEntityType" NOT NULL,
    "entityId" TEXT NOT NULL,
    "externalOrderId" TEXT,
    "externalCustomerId" TEXT,
    "externalProductId" TEXT,
    "externalSku" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ChannelReference_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ChannelReference_channel_externalOrderId_idx" ON "ChannelReference"("channel", "externalOrderId");

-- CreateIndex
CREATE INDEX "ChannelReference_channel_externalCustomerId_idx" ON "ChannelReference"("channel", "externalCustomerId");

-- CreateIndex
CREATE INDEX "ChannelReference_channel_externalProductId_idx" ON "ChannelReference"("channel", "externalProductId");

-- CreateIndex
CREATE INDEX "ChannelReference_channel_externalSku_idx" ON "ChannelReference"("channel", "externalSku");

-- CreateIndex
CREATE UNIQUE INDEX "ChannelReference_channel_entityType_entityId_key" ON "ChannelReference"("channel", "entityType", "entityId");
