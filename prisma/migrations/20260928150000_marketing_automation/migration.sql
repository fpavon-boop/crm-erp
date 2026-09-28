-- Marketing automation module (docs/MARKETING_AUTOMATION_ARCHITECTURE.md), Stages 1-10.
-- Purely additive: creates Marketing*/Social*/Video*/CampaignApproval tables and
-- marketing enums only. No core table is altered, and no foreign key points at a
-- core table (products/contacts/companies/users are soft string references).
-- Generated with: prisma migrate diff --from-schema-datamodel <schema@8a03972> --to-schema-datamodel prisma/schema.prisma --script

-- CreateEnum
CREATE TYPE "MarketingApprovalStatus" AS ENUM ('DRAFT', 'AI_GENERATED', 'HUMAN_REVIEW', 'APPROVED', 'REJECTED', 'SCHEDULED', 'PUBLISHED', 'FAILED');

-- CreateEnum
CREATE TYPE "MarketingChannel" AS ENUM ('FACEBOOK', 'INSTAGRAM', 'TIKTOK', 'WHATSAPP', 'EMAIL', 'WEBSITE');

-- CreateEnum
CREATE TYPE "SocialPlatform" AS ENUM ('FACEBOOK', 'INSTAGRAM', 'TIKTOK');

-- CreateEnum
CREATE TYPE "SocialAccountStatus" AS ENUM ('ACTIVE', 'DISCONNECTED', 'REVOKED');

-- CreateEnum
CREATE TYPE "MarketingContentType" AS ENUM ('POST_COPY', 'CAPTION', 'AD_COPY', 'EMAIL', 'WHATSAPP_MESSAGE', 'BLOG', 'VIDEO_SCRIPT', 'HASHTAGS', 'POST_CONCEPT');

-- CreateEnum
CREATE TYPE "MarketingAssetType" AS ENUM ('IMAGE', 'VIDEO', 'AUDIO', 'DOCUMENT');

-- CreateEnum
CREATE TYPE "MarketingAssetSource" AS ENUM ('UPLOAD', 'CANVA', 'CAPCUT', 'AI_GENERATED', 'N8N', 'EXTERNAL_URL', 'ERP_DOCUMENT');

-- CreateEnum
CREATE TYPE "MarketingAssetOrientation" AS ENUM ('SQUARE', 'VERTICAL', 'LANDSCAPE');

-- CreateEnum
CREATE TYPE "MarketingTemplateKind" AS ENUM ('SOCIAL_POST', 'EMAIL', 'WHATSAPP', 'VIDEO', 'DESIGN');

-- CreateEnum
CREATE TYPE "MarketingTemplateProvider" AS ENUM ('INTERNAL', 'CANVA', 'CAPCUT', 'META_WHATSAPP');

-- CreateEnum
CREATE TYPE "VideoRenderStatus" AS ENUM ('NOT_STARTED', 'QUEUED', 'RENDERING', 'COMPLETED', 'FAILED');

-- CreateEnum
CREATE TYPE "MarketingJobType" AS ENUM ('CONTENT_GENERATION', 'VIDEO_RENDER', 'SOCIAL_PUBLISH', 'MESSAGE_SEND', 'ANALYTICS_SYNC');

-- CreateEnum
CREATE TYPE "MarketingScheduleStatus" AS ENUM ('PENDING', 'DISPATCHED', 'COMPLETED', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "MarketingApprovalTarget" AS ENUM ('CAMPAIGN', 'CONTENT', 'ASSET', 'VIDEO_PROJECT', 'SOCIAL_POST');

-- CreateEnum
CREATE TYPE "MarketingSafeguardVerdict" AS ENUM ('PASS', 'WARN', 'BLOCK');

-- CreateEnum
CREATE TYPE "MarketingLanguage" AS ENUM ('EN', 'ES');

-- CreateEnum
CREATE TYPE "VideoPlatform" AS ENUM ('TIKTOK', 'INSTAGRAM_REELS', 'FACEBOOK_REELS');

-- CreateEnum
CREATE TYPE "VideoTextPosition" AS ENUM ('TOP', 'CENTER', 'BOTTOM');

-- CreateEnum
CREATE TYPE "VideoTransition" AS ENUM ('CUT', 'FADE', 'SLIDE', 'ZOOM');

-- CreateEnum
CREATE TYPE "MarketingAiCallStatus" AS ENUM ('SUCCESS', 'FAILED', 'VALIDATION_FAILED');

-- CreateTable
CREATE TABLE "MarketingBrandProfile" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "primaryLanguage" "MarketingLanguage" NOT NULL DEFAULT 'EN',
    "voice" TEXT,
    "tone" TEXT,
    "targetAudience" TEXT,
    "guidelines" TEXT,
    "bannedPhrases" TEXT[],
    "defaultHashtags" TEXT[],
    "primaryColor" TEXT,
    "secondaryColor" TEXT,
    "colorPalette" JSONB,
    "logoUrl" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MarketingBrandProfile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MarketingBrandLocale" (
    "id" TEXT NOT NULL,
    "brandProfileId" TEXT NOT NULL,
    "language" "MarketingLanguage" NOT NULL,
    "voice" TEXT NOT NULL,
    "tone" TEXT NOT NULL,
    "tagline" TEXT,
    "guidelines" TEXT,
    "bannedPhrases" TEXT[],
    "requiredDisclaimer" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MarketingBrandLocale_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MarketingBrandTerm" (
    "id" TEXT NOT NULL,
    "brandProfileId" TEXT NOT NULL,
    "conceptKey" TEXT NOT NULL,
    "language" "MarketingLanguage" NOT NULL,
    "term" TEXT NOT NULL,
    "discouraged" TEXT[],
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MarketingBrandTerm_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MarketingCampaign" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "objective" TEXT,
    "description" TEXT,
    "status" "MarketingApprovalStatus" NOT NULL DEFAULT 'DRAFT',
    "channels" "MarketingChannel"[],
    "brandProfileId" TEXT,
    "audienceId" TEXT,
    "productIds" TEXT[],
    "productVariantIds" TEXT[],
    "discountPct" DECIMAL(5,2),
    "startsAt" TIMESTAMP(3),
    "endsAt" TIMESTAMP(3),
    "createdById" TEXT,
    "approvedById" TEXT,
    "approvedAt" TIMESTAMP(3),
    "budget" DECIMAL(14,2),
    "sourcePrompt" TEXT,
    "strategy" JSONB,
    "safeguardSnapshot" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MarketingCampaign_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MarketingContent" (
    "id" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "channel" "MarketingChannel" NOT NULL,
    "type" "MarketingContentType" NOT NULL,
    "title" TEXT,
    "body" TEXT NOT NULL,
    "hashtags" TEXT[],
    "language" TEXT NOT NULL DEFAULT 'en',
    "version" INTEGER NOT NULL DEFAULT 1,
    "status" "MarketingApprovalStatus" NOT NULL DEFAULT 'DRAFT',
    "aiGenerated" BOOLEAN NOT NULL DEFAULT false,
    "aiModel" TEXT,
    "promptId" TEXT,
    "productIds" TEXT[],
    "reviewedById" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "rejectionReason" TEXT,
    "variantGroupId" TEXT,
    "compliance" JSONB,
    "aiLogId" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MarketingContent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MarketingAsset" (
    "id" TEXT NOT NULL,
    "name" TEXT,
    "tags" TEXT[],
    "aspectRatio" TEXT,
    "orientation" "MarketingAssetOrientation",
    "sourceDocumentId" TEXT,
    "archivedAt" TIMESTAMP(3),
    "campaignId" TEXT,
    "type" "MarketingAssetType" NOT NULL,
    "source" "MarketingAssetSource" NOT NULL,
    "url" TEXT NOT NULL,
    "storageKey" TEXT,
    "externalId" TEXT,
    "mimeType" TEXT,
    "sizeBytes" INTEGER,
    "width" INTEGER,
    "height" INTEGER,
    "durationSec" DECIMAL(8,2),
    "checksum" TEXT,
    "altText" TEXT,
    "status" "MarketingApprovalStatus" NOT NULL DEFAULT 'DRAFT',
    "productIds" TEXT[],
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MarketingAsset_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MarketingTemplate" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" "MarketingTemplateKind" NOT NULL,
    "provider" "MarketingTemplateProvider" NOT NULL DEFAULT 'INTERNAL',
    "channel" "MarketingChannel",
    "externalTemplateId" TEXT,
    "body" TEXT,
    "description" TEXT,
    "variables" JSONB,
    "placeholders" TEXT[],
    "createdById" TEXT,
    "brandProfileId" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MarketingTemplate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VideoProject" (
    "id" TEXT NOT NULL,
    "campaignId" TEXT,
    "templateId" TEXT,
    "title" TEXT NOT NULL,
    "aspectRatio" TEXT NOT NULL DEFAULT '9:16',
    "targetDurationSec" INTEGER,
    "script" TEXT,
    "status" "MarketingApprovalStatus" NOT NULL DEFAULT 'DRAFT',
    "renderStatus" "VideoRenderStatus" NOT NULL DEFAULT 'NOT_STARTED',
    "externalJobId" TEXT,
    "outputAssetId" TEXT,
    "errorMessage" TEXT,
    "platform" "VideoPlatform" NOT NULL DEFAULT 'TIKTOK',
    "language" "MarketingLanguage" NOT NULL DEFAULT 'EN',
    "version" INTEGER NOT NULL DEFAULT 1,
    "approvedVersion" INTEGER,
    "approvedById" TEXT,
    "approvedAt" TIMESTAMP(3),
    "audioAssetId" TEXT,
    "renderRequestedAt" TIMESTAMP(3),
    "renderedAt" TIMESTAMP(3),
    "renderAttempts" INTEGER NOT NULL DEFAULT 0,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "VideoProject_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VideoScene" (
    "id" TEXT NOT NULL,
    "videoProjectId" TEXT NOT NULL,
    "order" INTEGER NOT NULL,
    "script" TEXT,
    "voiceover" TEXT,
    "onScreenText" TEXT,
    "visualCue" TEXT,
    "textPosition" "VideoTextPosition",
    "textBox" JSONB,
    "transition" "VideoTransition" NOT NULL DEFAULT 'CUT',
    "durationSec" DECIMAL(8,2),
    "assetId" TEXT,
    "productId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "VideoScene_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SocialAccount" (
    "id" TEXT NOT NULL,
    "platform" "SocialPlatform" NOT NULL,
    "externalAccountId" TEXT NOT NULL,
    "handle" TEXT,
    "displayName" TEXT,
    "n8nCredentialRef" TEXT,
    "status" "SocialAccountStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SocialAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SocialPost" (
    "id" TEXT NOT NULL,
    "socialAccountId" TEXT NOT NULL,
    "campaignId" TEXT,
    "contentId" TEXT,
    "videoProjectId" TEXT,
    "mediaAssetIds" TEXT[],
    "caption" TEXT,
    "status" "MarketingApprovalStatus" NOT NULL DEFAULT 'DRAFT',
    "scheduledFor" TIMESTAMP(3),
    "publishedAt" TIMESTAMP(3),
    "externalPostId" TEXT,
    "permalink" TEXT,
    "errorMessage" TEXT,
    "language" "MarketingLanguage" NOT NULL DEFAULT 'EN',
    "version" INTEGER NOT NULL DEFAULT 1,
    "approvedVersion" INTEGER,
    "approvedById" TEXT,
    "approvedAt" TIMESTAMP(3),
    "compliance" JSONB,
    "safeguardSnapshot" JSONB,
    "dispatchJobId" TEXT,
    "dispatchGeneration" INTEGER NOT NULL DEFAULT 0,
    "dispatchedAt" TIMESTAMP(3),
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SocialPost_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MarketingSchedule" (
    "id" TEXT NOT NULL,
    "jobType" "MarketingJobType" NOT NULL,
    "status" "MarketingScheduleStatus" NOT NULL DEFAULT 'PENDING',
    "runAt" TIMESTAMP(3) NOT NULL,
    "campaignId" TEXT,
    "socialPostId" TEXT,
    "n8nWorkflow" TEXT,
    "payload" JSONB,
    "result" JSONB,
    "attempt" INTEGER NOT NULL DEFAULT 0,
    "maxAttempts" INTEGER NOT NULL DEFAULT 3,
    "lastError" TEXT,
    "idempotencyKey" TEXT,
    "checksum" TEXT,
    "dispatchedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MarketingSchedule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MarketingAnalytics" (
    "id" TEXT NOT NULL,
    "campaignId" TEXT,
    "socialPostId" TEXT,
    "channel" "MarketingChannel" NOT NULL,
    "periodStart" TIMESTAMP(3) NOT NULL,
    "periodEnd" TIMESTAMP(3) NOT NULL,
    "impressions" INTEGER NOT NULL DEFAULT 0,
    "reach" INTEGER NOT NULL DEFAULT 0,
    "clicks" INTEGER NOT NULL DEFAULT 0,
    "engagements" INTEGER NOT NULL DEFAULT 0,
    "videoViews" INTEGER NOT NULL DEFAULT 0,
    "conversions" INTEGER NOT NULL DEFAULT 0,
    "spend" DECIMAL(14,2),
    "attributedRevenue" DECIMAL(14,2),
    "raw" JSONB,
    "capturedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MarketingAnalytics_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CampaignApproval" (
    "id" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "targetType" "MarketingApprovalTarget" NOT NULL,
    "targetId" TEXT NOT NULL,
    "fromStatus" "MarketingApprovalStatus" NOT NULL,
    "toStatus" "MarketingApprovalStatus" NOT NULL,
    "decidedById" TEXT NOT NULL,
    "comment" TEXT,
    "safeguardVerdict" "MarketingSafeguardVerdict",
    "safeguardSnapshot" JSONB,
    "warningsAcknowledged" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CampaignApproval_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MarketingAudience" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "channel" "MarketingChannel" NOT NULL,
    "criteria" JSONB NOT NULL,
    "lastSizeCount" INTEGER,
    "lastComputedAt" TIMESTAMP(3),
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MarketingAudience_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MarketingPrompt" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "name" TEXT NOT NULL,
    "purpose" TEXT,
    "systemPrompt" TEXT NOT NULL,
    "userTemplate" TEXT NOT NULL,
    "model" TEXT,
    "maxTokens" INTEGER,
    "variables" JSONB,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MarketingPrompt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MarketingAiLog" (
    "id" TEXT NOT NULL,
    "templateKey" TEXT NOT NULL,
    "templateVersion" INTEGER NOT NULL,
    "status" "MarketingAiCallStatus" NOT NULL,
    "provider" TEXT,
    "model" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "fallbackUsed" BOOLEAN NOT NULL DEFAULT false,
    "latencyMs" INTEGER NOT NULL,
    "inputTokens" INTEGER,
    "outputTokens" INTEGER,
    "requestId" TEXT,
    "promptHash" TEXT NOT NULL,
    "redactions" JSONB,
    "errorKind" TEXT,
    "errorMessage" TEXT,
    "complianceVerdict" "MarketingSafeguardVerdict",
    "campaignId" TEXT,
    "contentId" TEXT,
    "requestedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MarketingAiLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "MarketingBrandLocale_brandProfileId_language_key" ON "MarketingBrandLocale"("brandProfileId", "language");

-- CreateIndex
CREATE INDEX "MarketingBrandTerm_brandProfileId_language_idx" ON "MarketingBrandTerm"("brandProfileId", "language");

-- CreateIndex
CREATE UNIQUE INDEX "MarketingBrandTerm_brandProfileId_conceptKey_language_key" ON "MarketingBrandTerm"("brandProfileId", "conceptKey", "language");

-- CreateIndex
CREATE INDEX "MarketingCampaign_status_idx" ON "MarketingCampaign"("status");

-- CreateIndex
CREATE INDEX "MarketingCampaign_startsAt_idx" ON "MarketingCampaign"("startsAt");

-- CreateIndex
CREATE INDEX "MarketingContent_campaignId_status_idx" ON "MarketingContent"("campaignId", "status");

-- CreateIndex
CREATE INDEX "MarketingContent_status_idx" ON "MarketingContent"("status");

-- CreateIndex
CREATE INDEX "MarketingContent_variantGroupId_idx" ON "MarketingContent"("variantGroupId");

-- CreateIndex
CREATE INDEX "MarketingAsset_campaignId_idx" ON "MarketingAsset"("campaignId");

-- CreateIndex
CREATE INDEX "MarketingAsset_sourceDocumentId_idx" ON "MarketingAsset"("sourceDocumentId");

-- CreateIndex
CREATE INDEX "MarketingAsset_orientation_idx" ON "MarketingAsset"("orientation");

-- CreateIndex
CREATE UNIQUE INDEX "MarketingAsset_source_externalId_key" ON "MarketingAsset"("source", "externalId");

-- CreateIndex
CREATE UNIQUE INDEX "MarketingTemplate_provider_externalTemplateId_key" ON "MarketingTemplate"("provider", "externalTemplateId");

-- CreateIndex
CREATE UNIQUE INDEX "VideoProject_externalJobId_key" ON "VideoProject"("externalJobId");

-- CreateIndex
CREATE INDEX "VideoProject_campaignId_idx" ON "VideoProject"("campaignId");

-- CreateIndex
CREATE INDEX "VideoProject_renderStatus_idx" ON "VideoProject"("renderStatus");

-- CreateIndex
CREATE UNIQUE INDEX "VideoScene_videoProjectId_order_key" ON "VideoScene"("videoProjectId", "order");

-- CreateIndex
CREATE UNIQUE INDEX "SocialAccount_platform_externalAccountId_key" ON "SocialAccount"("platform", "externalAccountId");

-- CreateIndex
CREATE UNIQUE INDEX "SocialPost_dispatchJobId_key" ON "SocialPost"("dispatchJobId");

-- CreateIndex
CREATE INDEX "SocialPost_status_scheduledFor_idx" ON "SocialPost"("status", "scheduledFor");

-- CreateIndex
CREATE INDEX "SocialPost_campaignId_idx" ON "SocialPost"("campaignId");

-- CreateIndex
CREATE UNIQUE INDEX "SocialPost_socialAccountId_externalPostId_key" ON "SocialPost"("socialAccountId", "externalPostId");

-- CreateIndex
CREATE UNIQUE INDEX "MarketingSchedule_idempotencyKey_key" ON "MarketingSchedule"("idempotencyKey");

-- CreateIndex
CREATE INDEX "MarketingSchedule_status_runAt_idx" ON "MarketingSchedule"("status", "runAt");

-- CreateIndex
CREATE INDEX "MarketingSchedule_campaignId_idx" ON "MarketingSchedule"("campaignId");

-- CreateIndex
CREATE INDEX "MarketingAnalytics_campaignId_periodStart_idx" ON "MarketingAnalytics"("campaignId", "periodStart");

-- CreateIndex
CREATE INDEX "MarketingAnalytics_socialPostId_periodStart_idx" ON "MarketingAnalytics"("socialPostId", "periodStart");

-- CreateIndex
CREATE INDEX "CampaignApproval_campaignId_createdAt_idx" ON "CampaignApproval"("campaignId", "createdAt");

-- CreateIndex
CREATE INDEX "CampaignApproval_targetType_targetId_idx" ON "CampaignApproval"("targetType", "targetId");

-- CreateIndex
CREATE UNIQUE INDEX "MarketingPrompt_key_version_key" ON "MarketingPrompt"("key", "version");

-- CreateIndex
CREATE INDEX "MarketingAiLog_templateKey_createdAt_idx" ON "MarketingAiLog"("templateKey", "createdAt");

-- CreateIndex
CREATE INDEX "MarketingAiLog_status_createdAt_idx" ON "MarketingAiLog"("status", "createdAt");

-- CreateIndex
CREATE INDEX "MarketingAiLog_campaignId_idx" ON "MarketingAiLog"("campaignId");

-- AddForeignKey
ALTER TABLE "MarketingBrandLocale" ADD CONSTRAINT "MarketingBrandLocale_brandProfileId_fkey" FOREIGN KEY ("brandProfileId") REFERENCES "MarketingBrandProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MarketingBrandTerm" ADD CONSTRAINT "MarketingBrandTerm_brandProfileId_fkey" FOREIGN KEY ("brandProfileId") REFERENCES "MarketingBrandProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MarketingCampaign" ADD CONSTRAINT "MarketingCampaign_brandProfileId_fkey" FOREIGN KEY ("brandProfileId") REFERENCES "MarketingBrandProfile"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MarketingCampaign" ADD CONSTRAINT "MarketingCampaign_audienceId_fkey" FOREIGN KEY ("audienceId") REFERENCES "MarketingAudience"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MarketingContent" ADD CONSTRAINT "MarketingContent_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "MarketingCampaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MarketingContent" ADD CONSTRAINT "MarketingContent_promptId_fkey" FOREIGN KEY ("promptId") REFERENCES "MarketingPrompt"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MarketingAsset" ADD CONSTRAINT "MarketingAsset_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "MarketingCampaign"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MarketingTemplate" ADD CONSTRAINT "MarketingTemplate_brandProfileId_fkey" FOREIGN KEY ("brandProfileId") REFERENCES "MarketingBrandProfile"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VideoProject" ADD CONSTRAINT "VideoProject_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "MarketingCampaign"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VideoProject" ADD CONSTRAINT "VideoProject_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "MarketingTemplate"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VideoProject" ADD CONSTRAINT "VideoProject_outputAssetId_fkey" FOREIGN KEY ("outputAssetId") REFERENCES "MarketingAsset"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VideoScene" ADD CONSTRAINT "VideoScene_videoProjectId_fkey" FOREIGN KEY ("videoProjectId") REFERENCES "VideoProject"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VideoScene" ADD CONSTRAINT "VideoScene_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "MarketingAsset"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SocialPost" ADD CONSTRAINT "SocialPost_socialAccountId_fkey" FOREIGN KEY ("socialAccountId") REFERENCES "SocialAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SocialPost" ADD CONSTRAINT "SocialPost_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "MarketingCampaign"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SocialPost" ADD CONSTRAINT "SocialPost_contentId_fkey" FOREIGN KEY ("contentId") REFERENCES "MarketingContent"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SocialPost" ADD CONSTRAINT "SocialPost_videoProjectId_fkey" FOREIGN KEY ("videoProjectId") REFERENCES "VideoProject"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MarketingSchedule" ADD CONSTRAINT "MarketingSchedule_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "MarketingCampaign"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MarketingSchedule" ADD CONSTRAINT "MarketingSchedule_socialPostId_fkey" FOREIGN KEY ("socialPostId") REFERENCES "SocialPost"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MarketingAnalytics" ADD CONSTRAINT "MarketingAnalytics_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "MarketingCampaign"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MarketingAnalytics" ADD CONSTRAINT "MarketingAnalytics_socialPostId_fkey" FOREIGN KEY ("socialPostId") REFERENCES "SocialPost"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CampaignApproval" ADD CONSTRAINT "CampaignApproval_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "MarketingCampaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;

