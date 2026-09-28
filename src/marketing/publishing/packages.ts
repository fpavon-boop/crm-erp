import crypto from 'crypto';
import type { MarketingAssetType, MarketingLanguage, MarketingSafeguardVerdict, SocialPlatform } from '@prisma/client';
import type { BrandContext } from '@/marketing/content/brand-profile';
import { CHANNEL_CHAR_LIMITS, validateCopy } from '@/marketing/content/terminology';
import { checkAssetForChannel } from '@/marketing/assets/media';
import { canonicalJson } from '@/marketing/videos/payload';
import { JOB_ID_HEADER, SIGNATURE_HEADER, TIMESTAMP_HEADER, signWebhook } from '@/marketing/security/signing';

/**
 * Pure building blocks for social publishing: idempotency keys, post
 * validation, platform-specific dispatch packages, and request signing.
 *
 * Idempotency model (end to end):
 * - key  = social-post:{postId}:v{version}:g{generation}
 * - jobId = "sp_" + sha256(key)[0..32]
 *   The same approved version of a post always maps to the same job, so a
 *   double-clicked "schedule" or a replayed request finds the existing job
 *   instead of creating a second one. `generation` only moves on an explicit
 *   ADMIN retry after a confirmed FAILED result.
 * - Every dispatch attempt re-sends the SAME stored package bytes (same
 *   checksum) with headers X-Mkt-Job-Id and Idempotency-Key; n8n must dedupe
 *   on them before calling the platform.
 * - Publish callbacks are applied at most once, and a second, different
 *   externalPostId for the same job is flagged rather than accepted.
 */

export const SOCIAL_PUBLISH_SCHEMA = 'marketing.social.publish/v1';
export const IDEMPOTENCY_HEADER = 'idempotency-key';

export function idempotencyKeyFor(postId: string, version: number, generation: number): string {
  return `social-post:${postId}:v${version}:g${generation}`;
}

export function jobIdFor(idempotencyKey: string): string {
  return `sp_${crypto.createHash('sha256').update(idempotencyKey).digest('hex').slice(0, 32)}`;
}

// =============================================================================
// Validation
// =============================================================================

export interface PostMedia {
  id: string;
  type: MarketingAssetType;
  url: string;
  mimeType: string | null;
  width: number | null;
  height: number | null;
  sizeBytes: number | null;
  durationSec: number | null;
  altText: string | null;
  archivedAt: Date | null;
}

export type PostIssueCode =
  | 'CAPTION_REQUIRED'
  | 'CAPTION_TOO_LONG'
  | 'TOO_MANY_HASHTAGS'
  | 'COPY_COMPLIANCE'
  | 'MEDIA_REQUIRED'
  | 'VIDEO_REQUIRED'
  | 'TOO_MANY_MEDIA'
  | 'MEDIA_NOT_FOUND'
  | 'MEDIA_ARCHIVED'
  | 'MEDIA_NOT_FIT'
  | 'MEDIA_URL_UNRESOLVED';

export interface PostIssue {
  code: PostIssueCode;
  severity: 'WARN' | 'BLOCK';
  message: string;
}

export const PLATFORM_POST_RULES: Record<SocialPlatform, { requiresMedia: boolean; requiresVideo: boolean; maxMedia: number; maxHashtags?: number }> = {
  INSTAGRAM: { requiresMedia: true, requiresVideo: false, maxMedia: 10, maxHashtags: 30 },
  FACEBOOK: { requiresMedia: false, requiresVideo: false, maxMedia: 10 },
  TIKTOK: { requiresMedia: true, requiresVideo: true, maxMedia: 1 },
};

export function validatePost(input: {
  platform: SocialPlatform;
  caption: string | null;
  media: PostMedia[];
  missingMediaIds?: string[];
  brand: BrandContext | null;
  language: MarketingLanguage;
  approvedDiscountPct: number | null;
  resolveAssetUrl?: (m: PostMedia) => string | null;
}): { verdict: MarketingSafeguardVerdict; issues: PostIssue[] } {
  const rules = PLATFORM_POST_RULES[input.platform];
  const issues: PostIssue[] = [];
  const add = (code: PostIssueCode, severity: 'WARN' | 'BLOCK', message: string) => issues.push({ code, severity, message });
  const caption = input.caption?.trim() ?? '';

  if (!caption && !input.media.length) add('CAPTION_REQUIRED', 'BLOCK', 'A post needs a caption or media');
  const limit = CHANNEL_CHAR_LIMITS[input.platform];
  if (limit && caption.length > limit) add('CAPTION_TOO_LONG', 'BLOCK', `Caption is ${caption.length} chars; ${input.platform} allows ${limit}`);
  const hashtags = caption.match(/#[\p{L}\p{N}_]+/gu)?.length ?? 0;
  if (rules.maxHashtags && hashtags > rules.maxHashtags) add('TOO_MANY_HASHTAGS', 'BLOCK', `${hashtags} hashtags; ${input.platform} allows ${rules.maxHashtags}`);

  if (caption && input.brand) {
    const r = validateCopy(caption, { brand: input.brand, language: input.language, approvedDiscountPct: input.approvedDiscountPct });
    for (const i of r.issues) add('COPY_COMPLIANCE', i.severity, i.message);
  }

  for (const id of input.missingMediaIds ?? []) add('MEDIA_NOT_FOUND', 'BLOCK', `Media asset ${id} does not exist`);
  if (rules.requiresMedia && !input.media.length) add('MEDIA_REQUIRED', 'BLOCK', `${input.platform} posts need media`);
  if (rules.requiresVideo && input.media.length && !input.media.some((m) => m.type === 'VIDEO')) {
    add('VIDEO_REQUIRED', 'BLOCK', `${input.platform} posts need a video`);
  }
  if (input.media.length > rules.maxMedia) add('TOO_MANY_MEDIA', 'BLOCK', `${input.platform} allows at most ${rules.maxMedia} media item(s)`);

  for (const m of input.media) {
    if (m.archivedAt) add('MEDIA_ARCHIVED', 'BLOCK', `Media ${m.id} is archived`);
    for (const i of checkAssetForChannel(m, input.platform)) add('MEDIA_NOT_FIT', i.severity, `Media ${m.id}: ${i.message}`);
    if (input.resolveAssetUrl && !input.resolveAssetUrl(m)) {
      add('MEDIA_URL_UNRESOLVED', 'BLOCK', `Media ${m.id} has no URL n8n can fetch (ERP-linked images need a signed URL)`);
    }
  }

  const verdict: MarketingSafeguardVerdict = issues.some((i) => i.severity === 'BLOCK') ? 'BLOCK' : issues.length ? 'WARN' : 'PASS';
  return { verdict, issues };
}

// =============================================================================
// Platform options & package
// =============================================================================

export function platformOptions(platform: SocialPlatform, media: Array<{ type: MarketingAssetType }>) {
  const videos = media.filter((m) => m.type === 'VIDEO').length;
  switch (platform) {
    case 'INSTAGRAM':
      return { mediaType: media.length > 1 ? 'CAROUSEL' : videos ? 'REELS' : 'IMAGE', shareToFeed: true };
    case 'FACEBOOK':
      return { postType: !media.length ? 'TEXT' : videos ? 'VIDEO' : media.length > 1 ? 'ALBUM' : 'PHOTO' };
    case 'TIKTOK':
      // Promotional content must carry TikTok's commercial-content disclosure.
      return { postMode: 'DIRECT_POST', privacyLevel: 'PUBLIC_TO_EVERYONE', commercialContent: { yourBrand: true }, disableComment: false };
  }
}

export interface PackageInput {
  jobId: string;
  idempotencyKey: string;
  platform: SocialPlatform;
  account: { id: string; externalAccountId: string; handle: string | null; n8nCredentialRef: string | null };
  post: {
    id: string;
    campaignId: string | null;
    version: number;
    language: MarketingLanguage;
    caption: string | null;
    scheduledFor: Date | null;
    approvedById: string | null;
    approvedAt: Date | null;
    approvedVersion: number | null;
  };
  media: PostMedia[];
  resolveAssetUrl: (m: PostMedia) => string | null;
  callbackUrl: string | null;
  createdAt: Date;
}

export function buildDispatchPackage(input: PackageInput) {
  const media = input.media.map((m, i) => {
    const url = input.resolveAssetUrl(m);
    if (!url) throw new Error(`Media ${m.id} has no renderer-accessible URL`);
    return { position: i + 1, assetId: m.id, type: m.type, url, mimeType: m.mimeType, width: m.width, height: m.height, durationSec: m.durationSec, altText: m.altText };
  });
  const body = {
    schema: SOCIAL_PUBLISH_SCHEMA,
    jobId: input.jobId,
    idempotencyKey: input.idempotencyKey,
    createdAt: input.createdAt.toISOString(),
    platform: input.platform,
    account: input.account,
    post: {
      id: input.post.id,
      campaignId: input.post.campaignId,
      version: input.post.version,
      language: input.post.language,
      caption: input.post.caption,
      scheduledFor: input.post.scheduledFor?.toISOString() ?? null,
    },
    media,
    platformOptions: platformOptions(input.platform, media),
    approval: {
      approvedById: input.post.approvedById,
      approvedAt: input.post.approvedAt?.toISOString() ?? null,
      approvedVersion: input.post.approvedVersion,
    },
    callback: input.callbackUrl ? { url: input.callbackUrl, events: ['post.published', 'post.failed'] } : null,
  };
  const checksum = crypto.createHash('sha256').update(canonicalJson(body)).digest('hex');
  return { ...body, checksum };
}

export type DispatchPackage = ReturnType<typeof buildDispatchPackage>;

/** Headers for one delivery attempt. The body must be the stored package
 * serialized canonically, so every retry is byte-identical. */
export function signedDispatchRequest(pkg: DispatchPackage, secret: string, nowMs: number) {
  const body = canonicalJson(pkg);
  const { timestamp, signature } = signWebhook(body, secret, nowMs);
  return {
    body,
    headers: {
      'content-type': 'application/json',
      [SIGNATURE_HEADER]: signature,
      [TIMESTAMP_HEADER]: timestamp,
      [JOB_ID_HEADER]: pkg.jobId,
      [IDEMPOTENCY_HEADER]: pkg.idempotencyKey,
    },
  };
}
