import { isMarketingEnabled } from '@/marketing/security/kill-switch';
import { defaultPublishingDeps, type PublishingDeps } from '@/marketing/publishing/deps';
import { dispatchDueSocialPosts, type DispatchOutcome } from '@/marketing/publishing/dispatch';
import { acquireMarketingLock, releaseMarketingLock } from './lock';
import { dispatchDueVideoRenders } from './video-dispatch';

/**
 * The unified marketing dispatcher tick: every pending MarketingSchedule job
 * (SOCIAL_PUBLISH and VIDEO_RENDER) under one marketing-owned lease lock,
 * behind the MARKETING_ENABLED kill switch.
 *
 * Triggered by POST /api/marketing/webhooks/dispatch (a signed n8n schedule
 * or an ADMIN). No in-process scheduler is added to the core app.
 */

export const DISPATCH_LOCK_ID = 'marketing-dispatch';
export const DISPATCH_LOCK_LEASE_MS = 5 * 60_000;

export type TickResult =
  | { ran: false; reason: 'DISABLED' | 'LOCKED' }
  | { ran: true; social: DispatchOutcome[]; video: DispatchOutcome[] };

export async function runMarketingDispatchTick(
  options: { limit?: number; enabled?: () => boolean } = {},
  deps: PublishingDeps = defaultPublishingDeps
): Promise<TickResult> {
  if (!(options.enabled ?? isMarketingEnabled)()) return { ran: false, reason: 'DISABLED' };
  const runId = await acquireMarketingLock(deps.db, DISPATCH_LOCK_ID, DISPATCH_LOCK_LEASE_MS, deps.now());
  if (!runId) return { ran: false, reason: 'LOCKED' };
  try {
    const social = await dispatchDueSocialPosts({ limit: options.limit }, deps);
    const video = await dispatchDueVideoRenders({ limit: options.limit }, deps);
    return { ran: true, social, video };
  } finally {
    await releaseMarketingLock(deps.db, DISPATCH_LOCK_ID, runId);
  }
}
