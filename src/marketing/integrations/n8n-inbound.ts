import { z } from 'zod';
import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { isMarketingEnabled } from '@/marketing/security/kill-switch';
import { SIGNATURE_HEADER, TIMESTAMP_HEADER, verifyWebhook } from '@/marketing/security/signing';
import { redactText } from '@/marketing/security/redaction';
import { MarketingError } from '@/marketing/errors';
import { classifyAspectRatio, validateMediaMetadata } from '@/marketing/assets/media';
import { recordPublishResult } from '@/marketing/publishing/post-service';
import { defaultPublishingDeps, type PublishingDeps } from '@/marketing/publishing/deps';
import { recordRenderEvent, defaultVideoDeps, type VideoDeps } from '@/marketing/videos/video-service';

/**
 * Inbound n8n callbacks (POST /api/marketing/webhooks/n8n).
 *
 *  1. Kill switch (503 → n8n retries later).
 *  2. HMAC-SHA256 over `${timestamp}.${rawBody}` with
 *     MARKETING_N8N_INBOUND_SECRET; timestamps older/newer than 5 min are
 *     rejected (401).
 *  3. Strict schema (400).
 *  4. Replay protection in the marketing-owned MarketingWebhookEvent table,
 *     unique on (source, eventId). n8n must send a stable eventId per event
 *     (e.g. its execution id + node) so its own retries dedupe. A processed
 *     event is never applied twice; a FAILED one may be reprocessed.
 *  5. Apply through the existing idempotent domain functions
 *     (recordPublishResult / recordRenderEvent).
 *
 * Responses: 200 processed/ignored/duplicate · 409 same event in flight ·
 * 422 domain rejection (recorded FAILED; retrying won't help) · 500
 * unexpected error (recorded FAILED; n8n should retry).
 */

export const N8N_SOURCE = 'n8n';
const IN_FLIGHT_MS = 5 * 60_000;

const id = z.string().trim().min(1).max(200);
const eventSchema = z.discriminatedUnion('type', [
  z.object({ eventId: id, type: z.literal('post.published'), jobId: id, data: z.object({ externalPostId: id, permalink: z.string().url().max(2048).optional() }).strict() }).strict(),
  z.object({ eventId: id, type: z.literal('post.failed'), jobId: id, data: z.object({ error: z.string().max(5000).optional() }).strict().default({}) }).strict(),
  z.object({ eventId: id, type: z.literal('render.started'), jobId: id, data: z.object({}).strict().default({}) }).strict(),
  z
    .object({
      eventId: id,
      type: z.literal('render.completed'),
      jobId: id,
      data: z
        .object({
          url: z.string().url().max(2048).startsWith('https://'),
          mimeType: z.string().max(100).default('video/mp4'),
          width: z.number().int().positive(),
          height: z.number().int().positive(),
          durationSec: z.number().positive().max(3600),
          sizeBytes: z.number().int().positive().optional(),
        })
        .strict(),
    })
    .strict(),
  z.object({ eventId: id, type: z.literal('render.failed'), jobId: id, data: z.object({ error: z.string().max(5000).optional() }).strict().default({}) }).strict(),
]);

export type N8nEvent = z.output<typeof eventSchema>;

export interface InboundDeps {
  db: Pick<typeof prisma, 'marketingWebhookEvent' | 'videoProject' | 'marketingAsset'>;
  publishing: PublishingDeps;
  video: VideoDeps;
  secret(): string | null;
  enabled(): boolean;
  now(): Date;
}

export const defaultInboundDeps: InboundDeps = {
  db: prisma,
  publishing: defaultPublishingDeps,
  video: defaultVideoDeps,
  secret: () => {
    const s = process.env.MARKETING_N8N_INBOUND_SECRET;
    return s && s.length >= 32 ? s : null;
  },
  enabled: isMarketingEnabled,
  now: () => new Date(),
};

export interface InboundResponse {
  status: number;
  body: Record<string, unknown>;
}

type Applied = { status: 'PROCESSED' | 'IGNORED'; outcome: Record<string, unknown> };

async function apply(e: N8nEvent, deps: InboundDeps): Promise<Applied> {
  if (e.type === 'post.published' || e.type === 'post.failed') {
    const r = await recordPublishResult(
      e.type === 'post.published'
        ? { jobId: e.jobId, status: 'PUBLISHED', externalPostId: e.data.externalPostId, permalink: e.data.permalink }
        : { jobId: e.jobId, status: 'FAILED', error: e.data.error },
      deps.publishing
    );
    return { status: r.applied ? 'PROCESSED' : 'IGNORED', outcome: { ...r } };
  }

  const project = await deps.db.videoProject.findFirst({ where: { externalJobId: e.jobId }, select: { id: true } });
  if (!project) return { status: 'IGNORED', outcome: { applied: false, reason: 'UNKNOWN_JOB' } };

  if (e.type === 'render.started') {
    const r = await recordRenderEvent(project.id, { jobId: e.jobId, status: 'RENDERING' }, deps.video);
    return { status: r.applied ? 'PROCESSED' : 'IGNORED', outcome: { ...r } };
  }
  if (e.type === 'render.failed') {
    const r = await recordRenderEvent(project.id, { jobId: e.jobId, status: 'FAILED', error: e.data.error }, deps.video);
    return { status: r.applied ? 'PROCESSED' : 'IGNORED', outcome: { ...r } };
  }

  // render.completed: register the output as a marketing asset (one per job:
  // (source N8N, externalId jobId) is unique), then complete the project.
  const d = e.data;
  const issues = validateMediaMetadata({ type: 'VIDEO', mimeType: d.mimeType, sizeBytes: d.sizeBytes ?? 1, width: d.width, height: d.height, durationSec: d.durationSec });
  const blocks = issues.filter((i) => i.severity === 'BLOCK');
  if (blocks.length) throw new MarketingError('RENDER_OUTPUT_INVALID', blocks.map((b) => b.message).join('; '), 422);

  let asset = await deps.db.marketingAsset.findFirst({ where: { source: 'N8N', externalId: e.jobId } });
  if (!asset) {
    const ratio = classifyAspectRatio(d.width, d.height);
    asset = await deps.db.marketingAsset
      .create({
      data: {
        type: 'VIDEO',
        source: 'N8N',
        externalId: e.jobId,
        url: d.url,
        mimeType: d.mimeType.toLowerCase(),
        sizeBytes: d.sizeBytes ?? null,
        width: d.width,
        height: d.height,
        durationSec: d.durationSec,
        aspectRatio: ratio.label,
        orientation: ratio.orientation,
        name: `Render ${e.jobId}`,
        status: 'DRAFT',
      },
      })
      .catch(async (err: { code?: string }) => {
        // A concurrent completion for the same job won the (source, externalId) unique race.
        const winner = err.code === 'P2002' ? await deps.db.marketingAsset.findFirst({ where: { source: 'N8N', externalId: e.jobId } }) : null;
        if (!winner) throw err;
        return winner;
      });
  }
  const r = await recordRenderEvent(project.id, { jobId: e.jobId, status: 'COMPLETED', outputAssetId: asset.id }, deps.video);
  return { status: r.applied ? 'PROCESSED' : 'IGNORED', outcome: { ...r, outputAssetId: asset.id, outputUrl: asset.url } };
}

/** Claims the event row for this delivery, or returns the response to send instead (duplicate / in flight). */
async function claim(e: N8nEvent, deps: InboundDeps): Promise<{ rowId: string } | InboundResponse> {
  try {
    const row = await deps.db.marketingWebhookEvent.create({ data: { source: N8N_SOURCE, eventId: e.eventId, type: e.type, jobId: e.jobId } });
    return { rowId: row.id };
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (!(err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') && code !== 'P2002') throw err;
  }
  const existing = await deps.db.marketingWebhookEvent.findUnique({ where: { source_eventId: { source: N8N_SOURCE, eventId: e.eventId } } });
  if (!existing) return { status: 409, body: { error: 'Event is being recorded; retry' } };
  if (existing.status === 'PROCESSED' || existing.status === 'IGNORED') {
    return { status: 200, body: { ok: true, duplicate: true, status: existing.status, outcome: existing.outcome } };
  }
  const inFlight = existing.status === 'RECEIVED' && deps.now().getTime() - existing.receivedAt.getTime() < IN_FLIGHT_MS;
  if (inFlight) return { status: 409, body: { error: 'Event is being processed; retry later' } };
  // FAILED (or a RECEIVED left behind by a crash): take it over, once.
  const { count } = await deps.db.marketingWebhookEvent.updateMany({
    where: { id: existing.id, status: existing.status, attempts: existing.attempts },
    data: { status: 'RECEIVED', attempts: { increment: 1 }, receivedAt: deps.now(), error: null },
  });
  return count === 1 ? { rowId: existing.id } : { status: 409, body: { error: 'Event is being processed; retry later' } };
}

export async function handleN8nWebhook(
  req: { rawBody: string; headers: { get(name: string): string | null } },
  deps: InboundDeps = defaultInboundDeps
): Promise<InboundResponse> {
  if (!deps.enabled()) return { status: 503, body: { error: 'Marketing module is disabled' } };
  const secret = deps.secret();
  if (!secret) return { status: 503, body: { error: 'Inbound webhook secret is not configured' } };

  const check = verifyWebhook({
    rawBody: req.rawBody,
    secret,
    timestamp: req.headers.get(TIMESTAMP_HEADER),
    signature: req.headers.get(SIGNATURE_HEADER),
    nowMs: deps.now().getTime(),
  });
  if (!check.ok) return { status: 401, body: { error: 'Unauthorized', reason: check.reason } };

  let json: unknown;
  try {
    json = JSON.parse(req.rawBody);
  } catch {
    return { status: 400, body: { error: 'Invalid JSON' } };
  }
  const parsed = eventSchema.safeParse(json);
  if (!parsed.success) return { status: 400, body: { error: 'Invalid event', issues: parsed.error.flatten() } };
  const event = parsed.data;

  const claimed = await claim(event, deps);
  if (!('rowId' in claimed)) return claimed;

  try {
    const result = await apply(event, deps);
    await deps.db.marketingWebhookEvent.update({
      where: { id: claimed.rowId },
      data: { status: result.status, outcome: result.outcome as Prisma.InputJsonValue, processedAt: deps.now() },
    });
    return { status: 200, body: { ok: true, status: result.status, outcome: result.outcome } };
  } catch (err) {
    const domain = err instanceof MarketingError && err.httpStatus < 500;
    const message = redactText(err instanceof Error ? err.message : String(err)).slice(0, 500);
    await deps.db.marketingWebhookEvent
      .update({ where: { id: claimed.rowId }, data: { status: 'FAILED', error: message, processedAt: deps.now() } })
      .catch(() => undefined);
    if (domain) return { status: 422, body: { error: message, code: (err as MarketingError).code } };
    console.error('[marketing-n8n] inbound processing failed:', err);
    return { status: 500, body: { error: 'Processing failed' } };
  }
}
