import crypto from 'crypto';
import type { MarketingAssetType, MarketingLanguage, VideoPlatform, VideoTextPosition, VideoTransition } from '@prisma/client';
import { PLACEHOLDER_CATALOG, type PlaceholderDeclaration, type PlaceholderValue } from '@/marketing/templates/placeholders';
import { VIDEO_PLATFORM_RULES, boxForPosition, isBoxValid, type Box } from './platform-rules';
import { buildTimeline, sortByOrder } from './sequence';

/**
 * Render payload assembler: a normalized, versioned, deterministic JSON
 * document handed to the n8n rendering workflow (and through it to a CapCut
 * template). Everything the renderer needs is explicit — resolved asset
 * URLs, integer-millisecond timeline, safe-zone overlay boxes, template
 * field values — so the workflow never has to call back into the CRM to
 * interpret the project.
 *
 * `checksum` is a SHA-256 of the canonical (sorted-key) JSON of everything
 * except the checksum itself; n8n can use it to verify integrity and as a
 * dedupe key alongside `jobId`.
 *
 * Contains marketing content only — no customer data, costs or margins.
 */

export const RENDER_PAYLOAD_SCHEMA = 'marketing.video.render/v1';

export interface PayloadAsset {
  id: string;
  type: MarketingAssetType;
  url: string;
  mimeType: string | null;
  width: number | null;
  height: number | null;
  durationSec: number | null;
}

export interface PayloadScene {
  id: string;
  order: number;
  durationSec: number;
  visualCue: string | null;
  onScreenText: string | null;
  voiceover: string | null;
  assetId: string | null;
  productId: string | null;
  textPosition: VideoTextPosition | null;
  textBox: unknown;
  transition: VideoTransition;
}

export interface PayloadTemplate {
  id: string;
  provider: string;
  externalTemplateId: string | null;
  placeholders: string[];
  declarations: PlaceholderDeclaration[];
}

export interface AssembleInput {
  jobId: string;
  project: {
    id: string;
    campaignId: string | null;
    title: string;
    platform: VideoPlatform;
    language: MarketingLanguage;
    aspectRatio: string;
    targetDurationSec: number | null;
    version: number;
    approvedVersion: number | null;
    approvedById: string | null;
    approvedAt: Date | null;
  };
  scenes: PayloadScene[];
  assets: Map<string, PayloadAsset>;
  audioAsset?: PayloadAsset | null;
  template?: PayloadTemplate | null;
  templateValues?: Record<string, PlaceholderValue>;
  callbackUrl?: string | null;
  /** Turns a stored asset URL into one the renderer can fetch (e.g. a signed
   * URL for auth-gated ERP documents). Default: https URLs pass through;
   * anything else is an error. */
  resolveAssetUrl?: (asset: PayloadAsset) => string | null;
  now?: Date;
}

export class PayloadAssemblyError extends Error {
  readonly problems: string[];
  constructor(problems: string[]) {
    super(`Render payload cannot be assembled: ${problems.join('; ')}`);
    this.name = 'PayloadAssemblyError';
    this.problems = problems;
  }
}

/** Stable JSON with sorted object keys (arrays keep order). */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
}

const defaultResolve = (a: PayloadAsset) => (a.url.startsWith('https://') ? a.url : null);

function formatTemplateValue(key: string, v: PlaceholderValue): string | null {
  if (v == null) return null;
  if (Array.isArray(v)) return v.join(' ');
  if (typeof v === 'number') {
    const type = PLACEHOLDER_CATALOG[key]?.type;
    if (type === 'currency') return `$${v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    if (type === 'percent') return `${v}%`;
    return String(v);
  }
  return v.trim() || null;
}

export function assembleRenderPayload(input: AssembleInput) {
  const { project } = input;
  const rule = VIDEO_PLATFORM_RULES[project.platform];
  const resolve = input.resolveAssetUrl ?? defaultResolve;
  const problems: string[] = [];

  if (project.approvedVersion == null || project.approvedVersion !== project.version || !project.approvedById) {
    problems.push('Project version is not ADMIN-approved');
  }

  const assetRef = (a: PayloadAsset | undefined, label: string) => {
    if (!a) return null;
    const url = resolve(a);
    if (!url) {
      problems.push(`${label}: asset ${a.id} has no renderer-accessible URL`);
      return null;
    }
    return { id: a.id, type: a.type, url, mimeType: a.mimeType, width: a.width, height: a.height, durationSec: a.durationSec };
  };

  const scenes = sortByOrder(input.scenes);
  const { entries, totalMs } = buildTimeline(scenes.map((s) => ({ id: s.id, order: s.order, durationSec: s.durationSec })));

  const payloadScenes = scenes.map((s, i) => {
    const t = entries[i];
    const text = s.onScreenText?.trim() || null;
    const box: Box | null = text
      ? isBoxValid(s.textBox)
        ? (s.textBox as Box)
        : boxForPosition(s.textPosition ?? 'CENTER', rule.safeZone)
      : null;
    if (s.assetId && !input.assets.has(s.assetId)) problems.push(`Scene ${s.order}: asset ${s.assetId} not loaded`);
    return {
      index: t.index,
      sceneId: s.id,
      startMs: t.startMs,
      endMs: t.endMs,
      durationMs: t.durationMs,
      visual: {
        cue: s.visualCue?.trim() || null,
        asset: s.assetId ? assetRef(input.assets.get(s.assetId), `Scene ${s.order}`) : null,
        fit: 'cover' as const,
      },
      overlay: text ? { text, position: s.textPosition ?? 'CENTER', box } : null,
      voiceover: s.voiceover?.trim() ? { text: s.voiceover.trim(), language: project.language } : null,
      productId: s.productId,
      transition: s.transition,
    };
  });

  let template: Record<string, unknown> | null = null;
  if (input.template) {
    const t = input.template;
    const declared = new Map(t.declarations.map((d) => [d.key, d]));
    const fields: Record<string, string> = {};
    for (const key of t.placeholders) {
      const value = formatTemplateValue(key, input.templateValues?.[key]);
      const required = declared.get(key)?.required ?? true;
      const max = declared.get(key)?.maxLength ?? PLACEHOLDER_CATALOG[key]?.maxLength;
      if (value == null) {
        if (required) problems.push(`Template field {{${key}}} has no value`);
        continue;
      }
      if (max && value.length > max) problems.push(`Template field {{${key}}} is ${value.length} chars; max ${max}`);
      fields[key] = value;
    }
    template = { id: t.id, provider: t.provider, externalTemplateId: t.externalTemplateId, fields };
  }

  const audio = input.audioAsset ? assetRef(input.audioAsset, 'Audio track') : null;
  if (problems.length) throw new PayloadAssemblyError(problems);

  const body = {
    schema: RENDER_PAYLOAD_SCHEMA,
    jobId: input.jobId,
    createdAt: (input.now ?? new Date()).toISOString(),
    project: {
      id: project.id,
      campaignId: project.campaignId,
      version: project.version,
      title: project.title,
      platform: project.platform,
      language: project.language,
      aspectRatio: project.aspectRatio,
      resolution: rule.resolution,
      fps: rule.fps,
      totalDurationMs: totalMs,
      targetDurationSec: project.targetDurationSec,
      safeZone: rule.safeZone,
    },
    approval: {
      approvedById: project.approvedById,
      approvedAt: project.approvedAt?.toISOString() ?? null,
      approvedVersion: project.approvedVersion,
    },
    template,
    audio,
    scenes: payloadScenes,
    callback: input.callbackUrl
      ? { url: input.callbackUrl, events: ['render.started', 'render.completed', 'render.failed'] }
      : null,
  };
  const checksum = crypto.createHash('sha256').update(canonicalJson(body)).digest('hex');
  return { ...body, checksum };
}

export type RenderPayload = ReturnType<typeof assembleRenderPayload>;
