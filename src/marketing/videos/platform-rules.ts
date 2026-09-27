import type {
  MarketingAssetOrientation,
  MarketingAssetType,
  MarketingChannel,
  MarketingLanguage,
  MarketingSafeguardVerdict,
  VideoPlatform,
  VideoTextPosition,
} from '@prisma/client';
import type { BrandContext } from '@/marketing/content/brand-profile';
import { validateCopy } from '@/marketing/content/terminology';
import { isContiguous, sortByOrder, toCentiseconds } from './sequence';

/**
 * Short-form video platform rules and the pure project validator.
 *
 * Platform numbers are conservative defaults from the platforms' published
 * guidance (they change); treat them as configuration to review. Safe zones
 * are the fractions of the 9:16 frame covered by platform UI (captions,
 * action buttons, top bar) where overlay text would be hidden.
 */

export interface SafeZone {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

export interface PlatformRule {
  label: string;
  channel: MarketingChannel;
  aspectRatios: string[];
  resolution: { width: number; height: number };
  fps: number;
  minDurationSec: number;
  maxDurationSec: number;
  /** Above this still works, but performs worse — WARN. */
  recommendedMaxSec: number;
  safeZone: SafeZone;
}

export const VIDEO_PLATFORM_RULES: Record<VideoPlatform, PlatformRule> = {
  TIKTOK: {
    label: 'TikTok',
    channel: 'TIKTOK',
    aspectRatios: ['9:16'],
    resolution: { width: 1080, height: 1920 },
    fps: 30,
    minDurationSec: 3,
    maxDurationSec: 600,
    recommendedMaxSec: 60,
    safeZone: { top: 0.1, bottom: 0.22, left: 0.06, right: 0.14 },
  },
  INSTAGRAM_REELS: {
    label: 'Instagram Reels',
    channel: 'INSTAGRAM',
    aspectRatios: ['9:16'],
    resolution: { width: 1080, height: 1920 },
    fps: 30,
    minDurationSec: 3,
    maxDurationSec: 180,
    recommendedMaxSec: 90,
    safeZone: { top: 0.14, bottom: 0.2, left: 0.06, right: 0.12 },
  },
  FACEBOOK_REELS: {
    label: 'Facebook Reels',
    channel: 'FACEBOOK',
    aspectRatios: ['9:16'],
    resolution: { width: 1080, height: 1920 },
    fps: 30,
    minDurationSec: 3,
    maxDurationSec: 90,
    recommendedMaxSec: 60,
    safeZone: { top: 0.14, bottom: 0.2, left: 0.06, right: 0.12 },
  },
};

/** Common target lengths offered in the UI; any value within platform limits is accepted. */
export const DURATION_PRESETS_SEC = [15, 30, 60, 90] as const;

export const SCENE_LIMITS = {
  minDurationSec: 0.5,
  maxDurationSec: 60,
  maxScenes: 30,
  overlayWarnChars: 80,
  overlayMaxChars: 150,
  /** Comfortable on-screen reading speed. */
  readingWordsPerSec: 3,
  /** ≈155 wpm — natural pace. Above WARN, above MAX it won't fit. */
  voiceoverWarnWordsPerSec: 2.6,
  voiceoverMaxWordsPerSec: 3.2,
  /** Runtime under this share of the target is flagged. */
  underTargetRatio: 0.8,
};

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

const OVERLAY_HEIGHT = 0.12;

/** The overlay box for a named position, placed inside the platform's safe
 * zone (so TOP/CENTER/BOTTOM are always safe by construction). */
export function boxForPosition(position: VideoTextPosition, zone: SafeZone): Box {
  const x = zone.left;
  const width = 1 - zone.left - zone.right;
  const safeTop = zone.top;
  const safeBottom = 1 - zone.bottom;
  const y =
    position === 'TOP' ? safeTop : position === 'BOTTOM' ? safeBottom - OVERLAY_HEIGHT : safeTop + (safeBottom - safeTop - OVERLAY_HEIGHT) / 2;
  const r = (n: number) => Math.round(n * 10000) / 10000;
  return { x: r(x), y: r(y), width: r(width), height: OVERLAY_HEIGHT };
}

export function isBoxValid(b: unknown): b is Box {
  const v = b as Box;
  return (
    !!v &&
    [v.x, v.y, v.width, v.height].every((n) => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 1) &&
    v.width > 0 &&
    v.height > 0 &&
    v.x + v.width <= 1 &&
    v.y + v.height <= 1
  );
}

const EPS = 1e-9;
export function boxInSafeZone(b: Box, zone: SafeZone): boolean {
  return b.x + EPS >= zone.left && b.x + b.width <= 1 - zone.right + EPS && b.y + EPS >= zone.top && b.y + b.height <= 1 - zone.bottom + EPS;
}

// =============================================================================
// Validator
// =============================================================================

export type VideoIssueCode =
  | 'ASPECT_RATIO_NOT_ALLOWED'
  | 'NO_SCENES'
  | 'TOO_MANY_SCENES'
  | 'SEQUENCE_BROKEN'
  | 'SCENE_DURATION_OUT_OF_RANGE'
  | 'BELOW_PLATFORM_MINIMUM'
  | 'EXCEEDS_PLATFORM_MAXIMUM'
  | 'EXCEEDS_TARGET_DURATION'
  | 'UNDER_TARGET_DURATION'
  | 'OVER_RECOMMENDED_DURATION'
  | 'TARGET_EXCEEDS_PLATFORM'
  | 'SCENE_HAS_NO_VISUAL'
  | 'ASSET_NOT_FOUND'
  | 'ASSET_ARCHIVED'
  | 'ASSET_TYPE_NOT_ALLOWED'
  | 'ASSET_ORIENTATION_MISMATCH'
  | 'ASSET_TOO_SHORT'
  | 'OVERLAY_BOX_INVALID'
  | 'OVERLAY_OUTSIDE_SAFE_ZONE'
  | 'OVERLAY_TEXT_TOO_LONG'
  | 'OVERLAY_READ_TIME'
  | 'VOICEOVER_TOO_FAST'
  | 'COPY_COMPLIANCE';

export interface VideoIssue {
  code: VideoIssueCode;
  severity: 'WARN' | 'BLOCK';
  message: string;
  sceneId?: string;
}

export interface ValidationProject {
  platform: VideoPlatform;
  aspectRatio: string;
  targetDurationSec: number | null;
  language: MarketingLanguage;
}

export interface ValidationScene {
  id: string;
  order: number;
  durationSec: number | null;
  visualCue: string | null;
  onScreenText: string | null;
  voiceover: string | null;
  assetId: string | null;
  textPosition: VideoTextPosition | null;
  textBox: unknown;
}

export interface ValidationAsset {
  id: string;
  type: MarketingAssetType;
  orientation: MarketingAssetOrientation | null;
  archivedAt: Date | null;
  durationSec: number | null;
}

export interface VideoValidation {
  verdict: MarketingSafeguardVerdict;
  issues: VideoIssue[];
  totalDurationSec: number;
}

function words(text: string | null): number {
  return text ? text.trim().split(/\s+/).filter(Boolean).length : 0;
}

export function validateVideoProject(input: {
  project: ValidationProject;
  scenes: ValidationScene[];
  assets: Map<string, ValidationAsset>;
  brand?: BrandContext | null;
  approvedDiscountPct?: number | null;
}): VideoValidation {
  const { project, assets, brand } = input;
  const rule = VIDEO_PLATFORM_RULES[project.platform];
  const scenes = sortByOrder(input.scenes);
  const issues: VideoIssue[] = [];
  const add = (code: VideoIssueCode, severity: 'WARN' | 'BLOCK', message: string, sceneId?: string) =>
    issues.push({ code, severity, message, ...(sceneId ? { sceneId } : {}) });

  if (!rule.aspectRatios.includes(project.aspectRatio)) {
    add('ASPECT_RATIO_NOT_ALLOWED', 'BLOCK', `${rule.label} requires ${rule.aspectRatios.join(' or ')}, not ${project.aspectRatio}`);
  }
  if (!scenes.length) add('NO_SCENES', 'BLOCK', 'Add at least one scene');
  if (scenes.length > SCENE_LIMITS.maxScenes) add('TOO_MANY_SCENES', 'BLOCK', `At most ${SCENE_LIMITS.maxScenes} scenes`);
  if (scenes.length && !isContiguous(scenes.map((s) => s.order))) {
    add('SEQUENCE_BROKEN', 'BLOCK', `Scene order must be 1..${scenes.length} with no gaps or duplicates`);
  }
  if (project.targetDurationSec != null && project.targetDurationSec > rule.maxDurationSec) {
    add('TARGET_EXCEEDS_PLATFORM', 'BLOCK', `Target ${project.targetDurationSec}s exceeds the ${rule.label} maximum of ${rule.maxDurationSec}s`);
  }

  let totalCs = 0;
  for (const s of scenes) {
    const d = s.durationSec ?? 0;
    totalCs += toCentiseconds(d);
    if (d < SCENE_LIMITS.minDurationSec || d > SCENE_LIMITS.maxDurationSec) {
      add('SCENE_DURATION_OUT_OF_RANGE', 'BLOCK', `Scene ${s.order} is ${d}s; each scene must be ${SCENE_LIMITS.minDurationSec}-${SCENE_LIMITS.maxDurationSec}s`, s.id);
    }

    // Visual
    if (!s.assetId && !s.visualCue?.trim()) {
      add('SCENE_HAS_NO_VISUAL', 'BLOCK', `Scene ${s.order} needs an asset or a visual cue`, s.id);
    }
    if (s.assetId) {
      const a = assets.get(s.assetId);
      if (!a) add('ASSET_NOT_FOUND', 'BLOCK', `Scene ${s.order} asset ${s.assetId} does not exist`, s.id);
      else {
        if (a.archivedAt) add('ASSET_ARCHIVED', 'BLOCK', `Scene ${s.order} uses an archived asset`, s.id);
        if (a.type !== 'IMAGE' && a.type !== 'VIDEO') add('ASSET_TYPE_NOT_ALLOWED', 'BLOCK', `Scene ${s.order}: ${a.type} assets can't be scene visuals`, s.id);
        if (a.orientation && a.orientation !== 'VERTICAL' && project.aspectRatio === '9:16') {
          const severity = a.type === 'VIDEO' ? 'BLOCK' : 'WARN';
          add('ASSET_ORIENTATION_MISMATCH', severity, `Scene ${s.order}: ${a.orientation.toLowerCase()} ${a.type.toLowerCase()} in a vertical video${severity === 'WARN' ? ' will be cropped' : ''}`, s.id);
        }
        if (a.type === 'VIDEO' && a.durationSec != null && a.durationSec + 1e-9 < d) {
          add('ASSET_TOO_SHORT', 'BLOCK', `Scene ${s.order} runs ${d}s but its clip is ${a.durationSec}s`, s.id);
        }
      }
    }

    // Overlay text
    if (s.onScreenText?.trim()) {
      const len = s.onScreenText.trim().length;
      if (len > SCENE_LIMITS.overlayMaxChars) add('OVERLAY_TEXT_TOO_LONG', 'BLOCK', `Scene ${s.order} overlay is ${len} chars (max ${SCENE_LIMITS.overlayMaxChars})`, s.id);
      else if (len > SCENE_LIMITS.overlayWarnChars) add('OVERLAY_TEXT_TOO_LONG', 'WARN', `Scene ${s.order} overlay is ${len} chars; aim for ≤${SCENE_LIMITS.overlayWarnChars}`, s.id);
      const readSec = words(s.onScreenText) / SCENE_LIMITS.readingWordsPerSec;
      if (d > 0 && readSec > d) add('OVERLAY_READ_TIME', 'WARN', `Scene ${s.order} overlay needs ~${readSec.toFixed(1)}s to read but shows for ${d}s`, s.id);

      if (s.textBox != null) {
        if (!isBoxValid(s.textBox)) add('OVERLAY_BOX_INVALID', 'BLOCK', `Scene ${s.order} textBox must be {x,y,width,height} within 0..1`, s.id);
        else if (!boxInSafeZone(s.textBox, rule.safeZone)) {
          add('OVERLAY_OUTSIDE_SAFE_ZONE', 'BLOCK', `Scene ${s.order} overlay would be hidden by ${rule.label} UI; keep it inside the safe zone`, s.id);
        }
      }
    }

    // Voiceover pacing
    if (s.voiceover?.trim() && d > 0) {
      const wps = words(s.voiceover) / d;
      if (wps > SCENE_LIMITS.voiceoverMaxWordsPerSec) {
        add('VOICEOVER_TOO_FAST', 'BLOCK', `Scene ${s.order} voiceover needs ${wps.toFixed(1)} words/s; max ${SCENE_LIMITS.voiceoverMaxWordsPerSec}`, s.id);
      } else if (wps > SCENE_LIMITS.voiceoverWarnWordsPerSec) {
        add('VOICEOVER_TOO_FAST', 'WARN', `Scene ${s.order} voiceover is fast (${wps.toFixed(1)} words/s)`, s.id);
      }
    }

    // Brand / compliance (same rules as all other copy)
    if (brand) {
      const text = [s.onScreenText, s.voiceover].filter((t) => t?.trim()).join('\n');
      if (text) {
        const r = validateCopy(text, { brand, language: project.language, approvedDiscountPct: input.approvedDiscountPct ?? null, checkDisclaimer: false });
        for (const i of r.issues) add('COPY_COMPLIANCE', i.severity, `Scene ${s.order}: ${i.message}`, s.id);
      }
    }
  }

  const total = totalCs / 100;
  if (scenes.length) {
    if (total < rule.minDurationSec) add('BELOW_PLATFORM_MINIMUM', 'BLOCK', `Runtime ${total}s is below the ${rule.label} minimum of ${rule.minDurationSec}s`);
    if (total > rule.maxDurationSec) add('EXCEEDS_PLATFORM_MAXIMUM', 'BLOCK', `Runtime ${total}s exceeds the ${rule.label} maximum of ${rule.maxDurationSec}s`);
    else if (total > rule.recommendedMaxSec) add('OVER_RECOMMENDED_DURATION', 'WARN', `Runtime ${total}s is above the recommended ${rule.recommendedMaxSec}s for ${rule.label}`);
    if (project.targetDurationSec != null) {
      if (totalCs > project.targetDurationSec * 100) {
        add('EXCEEDS_TARGET_DURATION', 'BLOCK', `Runtime ${total}s exceeds the ${project.targetDurationSec}s target`);
      } else if (total < project.targetDurationSec * SCENE_LIMITS.underTargetRatio) {
        add('UNDER_TARGET_DURATION', 'WARN', `Runtime ${total}s is well under the ${project.targetDurationSec}s target`);
      }
    }
  }

  const verdict: MarketingSafeguardVerdict = issues.some((i) => i.severity === 'BLOCK') ? 'BLOCK' : issues.length ? 'WARN' : 'PASS';
  return { verdict, issues, totalDurationSec: total };
}
