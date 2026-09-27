import type { MarketingAssetOrientation, MarketingAssetType, MarketingChannel } from '@prisma/client';

/**
 * Pure media rules for marketing assets: aspect-ratio classification,
 * image-header dimension probing, generic type/size/resolution validation,
 * and per-channel placement specs. No I/O.
 *
 * Channel limits below are conservative defaults based on the platforms'
 * published guidance; platforms change them, so treat them as configuration
 * to review rather than facts.
 */

export interface MediaIssue {
  code:
    | 'UNSUPPORTED_MIME'
    | 'FILE_TOO_LARGE'
    | 'MISSING_DIMENSIONS'
    | 'RESOLUTION_TOO_LOW'
    | 'BELOW_RECOMMENDED_RESOLUTION'
    | 'MISSING_DURATION'
    | 'DURATION_TOO_LONG'
    | 'ASPECT_RATIO_NOT_SUPPORTED'
    | 'TYPE_NOT_SUPPORTED_ON_CHANNEL';
  severity: 'WARN' | 'BLOCK';
  message: string;
}

// =============================================================================
// Aspect ratio
// =============================================================================

export const STANDARD_RATIOS = [
  { label: '1:1', value: 1 },
  { label: '4:5', value: 4 / 5 },
  { label: '9:16', value: 9 / 16 },
  { label: '16:9', value: 16 / 9 },
  { label: '1.91:1', value: 1.91 },
  { label: '4:3', value: 4 / 3 },
  { label: '3:4', value: 3 / 4 },
  { label: '2:3', value: 2 / 3 },
  { label: '3:2', value: 3 / 2 },
] as const;

export interface AspectRatioInfo {
  ratio: number;
  /** Nearest standard label within tolerance, else "custom". */
  label: string;
  orientation: MarketingAssetOrientation;
}

/** `tolerance` is relative (0.02 = within 2%), which absorbs off-by-a-few-
 * pixel exports like 1080×1921. */
export function classifyAspectRatio(width: number, height: number, tolerance = 0.02): AspectRatioInfo {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw new RangeError(`Invalid dimensions ${width}x${height}`);
  }
  const ratio = width / height;
  const orientation: MarketingAssetOrientation =
    Math.abs(ratio - 1) <= tolerance ? 'SQUARE' : ratio < 1 ? 'VERTICAL' : 'LANDSCAPE';
  let best: { label: string; diff: number } | null = null;
  for (const r of STANDARD_RATIOS) {
    const diff = Math.abs(ratio - r.value) / r.value;
    if (diff <= tolerance && (!best || diff < best.diff)) best = { label: r.label, diff };
  }
  return { ratio: Math.round(ratio * 10000) / 10000, label: best?.label ?? 'custom', orientation };
}

// =============================================================================
// Image dimension probing (header bytes only)
// =============================================================================

export interface ProbedImage {
  width: number;
  height: number;
  format: 'png' | 'jpeg' | 'gif' | 'webp';
}

/** Reads width/height from PNG, JPEG, GIF or WebP headers. Returns null for
 * anything else or a truncated/corrupt header. */
export function probeImageDimensions(buf: Buffer): ProbedImage | null {
  try {
    if (buf.length >= 24 && buf.readUInt32BE(0) === 0x89504e47 && buf.readUInt32BE(4) === 0x0d0a1a0a) {
      return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20), format: 'png' };
    }
    if (buf.length >= 10 && (buf.toString('ascii', 0, 6) === 'GIF87a' || buf.toString('ascii', 0, 6) === 'GIF89a')) {
      return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8), format: 'gif' };
    }
    if (buf.length >= 30 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') {
      const chunk = buf.toString('ascii', 12, 16);
      if (chunk === 'VP8 ') {
        return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff, format: 'webp' };
      }
      if (chunk === 'VP8L') {
        const b = buf.readUInt32LE(21);
        return { width: (b & 0x3fff) + 1, height: ((b >> 14) & 0x3fff) + 1, format: 'webp' };
      }
      if (chunk === 'VP8X') {
        return { width: 1 + buf.readUIntLE(24, 3), height: 1 + buf.readUIntLE(27, 3), format: 'webp' };
      }
      return null;
    }
    if (buf.length >= 4 && buf[0] === 0xff && buf[1] === 0xd8) {
      let i = 2;
      while (i + 9 < buf.length) {
        if (buf[i] !== 0xff) return null;
        const marker = buf[i + 1];
        if (marker === 0xff) {
          i += 1; // fill byte
          continue;
        }
        const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
        if (isSof) return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7), format: 'jpeg' };
        i += 2 + buf.readUInt16BE(i + 2);
      }
    }
  } catch {
    return null;
  }
  return null;
}

// =============================================================================
// Generic rules per asset type
// =============================================================================

const MB = 1024 * 1024;

export const ASSET_TYPE_RULES: Record<
  MarketingAssetType,
  { mimeTypes: string[]; maxBytes: number; minWidth?: number; minHeight?: number; needsDimensions: boolean; needsDuration: boolean; maxDurationSec?: number }
> = {
  IMAGE: { mimeTypes: ['image/jpeg', 'image/png', 'image/webp', 'image/gif'], maxBytes: 10 * MB, minWidth: 200, minHeight: 200, needsDimensions: true, needsDuration: false },
  VIDEO: { mimeTypes: ['video/mp4', 'video/quicktime', 'video/webm'], maxBytes: 1024 * MB, minWidth: 240, minHeight: 240, needsDimensions: true, needsDuration: true, maxDurationSec: 3600 },
  AUDIO: { mimeTypes: ['audio/mpeg', 'audio/mp4', 'audio/aac', 'audio/wav', 'audio/x-wav'], maxBytes: 50 * MB, needsDimensions: false, needsDuration: true, maxDurationSec: 3600 },
  DOCUMENT: { mimeTypes: ['application/pdf'], maxBytes: 25 * MB, needsDimensions: false, needsDuration: false },
};

export interface MediaMetadata {
  type: MarketingAssetType;
  mimeType: string;
  sizeBytes: number;
  width?: number | null;
  height?: number | null;
  durationSec?: number | null;
}

export function validateMediaMetadata(m: MediaMetadata): MediaIssue[] {
  const rules = ASSET_TYPE_RULES[m.type];
  const issues: MediaIssue[] = [];
  if (!rules.mimeTypes.includes(m.mimeType.toLowerCase())) {
    issues.push({ code: 'UNSUPPORTED_MIME', severity: 'BLOCK', message: `${m.mimeType} is not an accepted ${m.type} type (${rules.mimeTypes.join(', ')})` });
  }
  if (m.sizeBytes > rules.maxBytes) {
    issues.push({ code: 'FILE_TOO_LARGE', severity: 'BLOCK', message: `${(m.sizeBytes / MB).toFixed(1)} MB exceeds the ${rules.maxBytes / MB} MB ${m.type} limit` });
  }
  if (rules.needsDimensions) {
    if (!m.width || !m.height) {
      issues.push({ code: 'MISSING_DIMENSIONS', severity: 'BLOCK', message: `${m.type} assets need width and height` });
    } else if ((rules.minWidth && m.width < rules.minWidth) || (rules.minHeight && m.height < rules.minHeight)) {
      issues.push({ code: 'RESOLUTION_TOO_LOW', severity: 'BLOCK', message: `${m.width}x${m.height} is below the ${rules.minWidth}x${rules.minHeight} minimum` });
    }
  }
  if (rules.needsDuration) {
    if (!m.durationSec || m.durationSec <= 0) {
      issues.push({ code: 'MISSING_DURATION', severity: 'BLOCK', message: `${m.type} assets need a duration` });
    } else if (rules.maxDurationSec && m.durationSec > rules.maxDurationSec) {
      issues.push({ code: 'DURATION_TOO_LONG', severity: 'BLOCK', message: `${m.durationSec}s exceeds ${rules.maxDurationSec}s` });
    }
  }
  return issues;
}

// =============================================================================
// Channel placement specs
// =============================================================================

interface PlacementSpec {
  ratios: string[];
  minWidth: number;
  recommendedWidth: number;
  maxBytes: number;
  maxDurationSec?: number;
}

export const CHANNEL_MEDIA_SPECS: Partial<Record<MarketingChannel, Partial<Record<'IMAGE' | 'VIDEO', PlacementSpec>>>> = {
  INSTAGRAM: {
    IMAGE: { ratios: ['1:1', '4:5', '1.91:1'], minWidth: 320, recommendedWidth: 1080, maxBytes: 8 * MB },
    VIDEO: { ratios: ['9:16', '1:1', '4:5'], minWidth: 500, recommendedWidth: 1080, maxBytes: 1024 * MB, maxDurationSec: 900 },
  },
  FACEBOOK: {
    IMAGE: { ratios: ['1:1', '4:5', '1.91:1', '16:9'], minWidth: 600, recommendedWidth: 1080, maxBytes: 10 * MB },
    VIDEO: { ratios: ['16:9', '1:1', '4:5', '9:16'], minWidth: 600, recommendedWidth: 1080, maxBytes: 1024 * MB, maxDurationSec: 3600 },
  },
  TIKTOK: {
    IMAGE: { ratios: ['9:16', '1:1', '4:5'], minWidth: 540, recommendedWidth: 1080, maxBytes: 20 * MB },
    VIDEO: { ratios: ['9:16'], minWidth: 540, recommendedWidth: 1080, maxBytes: 287 * MB, maxDurationSec: 600 },
  },
};

/** Can this asset be placed on `channel`? Returns [] when it fits. */
export function checkAssetForChannel(
  asset: { type: MarketingAssetType; width?: number | null; height?: number | null; sizeBytes?: number | null; durationSec?: number | null },
  channel: MarketingChannel
): MediaIssue[] {
  const spec = asset.type === 'IMAGE' || asset.type === 'VIDEO' ? CHANNEL_MEDIA_SPECS[channel]?.[asset.type] : undefined;
  if (!spec) {
    return [{ code: 'TYPE_NOT_SUPPORTED_ON_CHANNEL', severity: 'BLOCK', message: `${asset.type} assets are not supported on ${channel}` }];
  }
  if (!asset.width || !asset.height) {
    return [{ code: 'MISSING_DIMENSIONS', severity: 'BLOCK', message: 'Asset has no dimensions' }];
  }
  const issues: MediaIssue[] = [];
  const { label } = classifyAspectRatio(asset.width, asset.height);
  if (!spec.ratios.includes(label)) {
    issues.push({
      code: 'ASPECT_RATIO_NOT_SUPPORTED',
      severity: 'BLOCK',
      message: `${label} (${asset.width}x${asset.height}) is not supported for ${channel} ${asset.type.toLowerCase()}s (${spec.ratios.join(', ')})`,
    });
  }
  if (asset.width < spec.minWidth) {
    issues.push({ code: 'RESOLUTION_TOO_LOW', severity: 'BLOCK', message: `Width ${asset.width}px is below ${channel}'s ${spec.minWidth}px minimum` });
  } else if (asset.width < spec.recommendedWidth) {
    issues.push({
      code: 'BELOW_RECOMMENDED_RESOLUTION',
      severity: 'WARN',
      message: `Width ${asset.width}px is below the recommended ${spec.recommendedWidth}px for ${channel}`,
    });
  }
  if (asset.sizeBytes && asset.sizeBytes > spec.maxBytes) {
    issues.push({ code: 'FILE_TOO_LARGE', severity: 'BLOCK', message: `Exceeds ${channel}'s ${spec.maxBytes / MB} MB limit` });
  }
  if (spec.maxDurationSec && asset.durationSec && asset.durationSec > spec.maxDurationSec) {
    issues.push({ code: 'DURATION_TOO_LONG', severity: 'BLOCK', message: `Exceeds ${channel}'s ${spec.maxDurationSec}s limit` });
  }
  return issues;
}
