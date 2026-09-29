import { prisma } from '@/lib/prisma';
import type { BrandContext } from '@/marketing/content/brand-profile';
import { defaultCampaignDeps } from '@/marketing/campaigns/engine';
import { defaultSafeguardChecks, type SafeguardChecks } from '@/marketing/campaigns/safeguard-gate';
import { getSigningSecret } from '@/marketing/security/signing';
import { resolvePublicAssetUrl } from '@/marketing/assets/signed-urls';
import type { PostMedia } from './packages';

export type PublishingDb = Pick<
  typeof prisma,
  | 'socialPost'
  | 'socialAccount'
  | 'marketingSchedule'
  | 'marketingCampaign'
  | 'marketingContent'
  | 'marketingAsset'
  | 'videoProject'
  | 'campaignApproval'
  | 'marketingLock'
  | '$transaction'
>;

export interface SendResult {
  status: number;
}

export interface PublishingDeps {
  db: PublishingDb;
  safeguards: SafeguardChecks;
  getBrand(brandProfileId?: string | null): Promise<BrandContext | null>;
  /** Read-only check against the core User table. */
  isActiveAdmin(userId: string): Promise<boolean>;
  /** Makes a stored asset URL fetchable by n8n; null if it can't. */
  resolveAssetUrl(asset: PostMedia): string | null;
  send(req: { url: string; headers: Record<string, string>; body: string }): Promise<SendResult>;
  webhookUrl(): string | null;
  /** n8n endpoint for VIDEO_RENDER jobs (defaults to N8N_MARKETING_WEBHOOK_URL/video-render). */
  videoWebhookUrl?(): string | null;
  callbackUrl(): string | null;
  signingSecret(): string;
  now(): Date;
}

async function defaultSend(req: { url: string; headers: Record<string, string>; body: string }): Promise<SendResult> {
  const res = await fetch(req.url, { method: 'POST', headers: req.headers, body: req.body, signal: AbortSignal.timeout(10_000) });
  return { status: res.status };
}

export const defaultPublishingDeps: PublishingDeps = {
  db: prisma,
  safeguards: defaultSafeguardChecks,
  getBrand: defaultCampaignDeps.getBrand,
  isActiveAdmin: async (userId) => {
    const u = await prisma.user.findUnique({ where: { id: userId }, select: { role: true, active: true } });
    return Boolean(u?.active && u.role === 'ADMIN');
  },
  // Public https assets pass through; ERP-linked images get a signed, time-limited URL.
  resolveAssetUrl: (a) => resolvePublicAssetUrl(a),
  send: defaultSend,
  webhookUrl: () => {
    const base = process.env.N8N_MARKETING_WEBHOOK_URL;
    return base ? `${base.replace(/\/$/, '')}/social-publish` : null;
  },
  videoWebhookUrl: () => {
    const base = process.env.N8N_MARKETING_WEBHOOK_URL;
    return base ? `${base.replace(/\/$/, '')}/video-render` : null;
  },
  callbackUrl: () => {
    const base = process.env.MARKETING_PUBLIC_BASE_URL;
    return base ? `${base.replace(/\/$/, '')}/api/marketing/webhooks/n8n` : null;
  },
  signingSecret: () => getSigningSecret('MARKETING_N8N_OUTBOUND_SECRET'),
  now: () => new Date(),
};
