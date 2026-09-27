import crypto from 'crypto';
import { z, ZodError } from 'zod';
import type { MarketingChannel, Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { readStoredFile } from '@/lib/uploads';
import { DEFAULT_PAGE_SIZE, pageWindow, totalPages } from '@/lib/pagination';
import { canPerform } from '@/marketing/security/rbac';
import { marketingErrors } from '@/marketing/errors';
import { checkAssetForChannel, classifyAspectRatio, probeImageDimensions, validateMediaMetadata, type MediaIssue } from './media';

/**
 * MarketingAsset lifecycle: register, link product images, update metadata,
 * list, archive, and channel-fit checks.
 *
 * Core isolation: product images live in the core `Document` table
 * (entityType PRODUCT) as files under UPLOADS_DIR. linkProductDocument()
 * READS the Document row and the file bytes (to learn dimensions and a
 * checksum) and creates a MarketingAsset that points at the existing,
 * auth-gated download route. It never copies, moves, renames or deletes the
 * file, never writes the Document row, and never stores the core storage
 * path. Archiving a marketing asset has no effect on the core file.
 */

type AssetDb = Pick<typeof prisma, 'marketingAsset' | 'socialPost'>;

export interface CoreDocumentRef {
  id: string;
  entityType: string;
  entityId: string;
  filename: string;
  storedPath: string;
  mimeType: string;
  size: number;
}

export interface AssetDeps {
  db: AssetDb;
  readDocument(id: string): Promise<CoreDocumentRef | null>;
  productExists(id: string): Promise<boolean>;
  readFile(storedPath: string): Promise<Buffer>;
}

export const defaultAssetDeps: AssetDeps = {
  db: prisma,
  readDocument: (id) =>
    prisma.document.findUnique({
      where: { id },
      select: { id: true, entityType: true, entityId: true, filename: true, storedPath: true, mimeType: true, size: true },
    }),
  productExists: async (id) => Boolean(await prisma.product.findUnique({ where: { id }, select: { id: true } })),
  readFile: readStoredFile,
};

export interface Actor {
  userId: string;
  role: string;
}

function requireRole(actor: Actor, action: 'view' | 'draft') {
  if (!canPerform(actor.role, action)) throw marketingErrors.forbidden(`Role ${actor.role} cannot ${action} assets`);
}

function parse<T>(schema: z.ZodType<T, any, unknown>, value: unknown): T {
  try {
    return schema.parse(value);
  } catch (err) {
    if (err instanceof ZodError) throw marketingErrors.invalidInput('Invalid asset input', err.flatten());
    throw err;
  }
}

function blocking(issues: MediaIssue[]) {
  const blocks = issues.filter((i) => i.severity === 'BLOCK');
  if (blocks.length) throw marketingErrors.unprocessable('ASSET_INVALID', blocks.map((b) => b.message).join('; '), blocks);
}

async function assertProductsExist(ids: string[], deps: AssetDeps) {
  const missing: string[] = [];
  for (const id of new Set(ids)) if (!(await deps.productExists(id))) missing.push(id);
  if (missing.length) throw marketingErrors.invalidInput(`Unknown product(s): ${missing.join(', ')}`);
}

const tag = z.string().trim().min(1).max(40);
const common = {
  name: z.string().trim().max(200).optional(),
  altText: z.string().trim().max(500).optional(),
  tags: z.array(tag).max(20).default([]),
  campaignId: z.string().trim().min(1).optional(),
  productIds: z.array(z.string().trim().min(1)).max(20).default([]),
};

export const registerAssetSchema = z
  .object({
    ...common,
    type: z.enum(['IMAGE', 'VIDEO', 'AUDIO', 'DOCUMENT']),
    source: z.enum(['UPLOAD', 'CANVA', 'CAPCUT', 'AI_GENERATED', 'N8N', 'EXTERNAL_URL']),
    url: z.string().url().max(2048).startsWith('https://', 'Asset URLs must be https'),
    storageKey: z.string().trim().max(500).optional(),
    externalId: z.string().trim().max(200).optional(),
    mimeType: z.string().trim().toLowerCase().max(100),
    sizeBytes: z.number().int().positive(),
    width: z.number().int().positive().optional(),
    height: z.number().int().positive().optional(),
    durationSec: z.number().positive().max(86_400).optional(),
    checksum: z.string().regex(/^[a-f0-9]{64}$/i, 'checksum must be a sha256 hex digest').transform((c) => c.toLowerCase()).optional(),
  })
  .strict();

function ratioFields(width?: number | null, height?: number | null) {
  if (!width || !height) return { aspectRatio: null, orientation: null };
  const info = classifyAspectRatio(width, height);
  return { aspectRatio: info.label, orientation: info.orientation };
}

// =============================================================================
// Register / link
// =============================================================================

export async function registerAsset(input: unknown, actor: Actor, deps: AssetDeps = defaultAssetDeps) {
  requireRole(actor, 'draft');
  const a = parse(registerAssetSchema, input);
  blocking(validateMediaMetadata(a));
  await assertProductsExist(a.productIds, deps);

  if (a.externalId) {
    const existing = await deps.db.marketingAsset.findFirst({ where: { source: a.source, externalId: a.externalId }, select: { id: true } });
    if (existing) throw marketingErrors.duplicate(`${a.source} asset ${a.externalId} is already registered`, { existingId: existing.id });
  }
  if (a.checksum) {
    const existing = await deps.db.marketingAsset.findFirst({ where: { checksum: a.checksum, archivedAt: null }, select: { id: true } });
    if (existing) throw marketingErrors.duplicate('An identical file is already registered', { existingId: existing.id });
  }

  const warnings: string[] = [];
  if (a.type === 'IMAGE' && !a.altText) warnings.push('Image has no alt text (needed for accessible posts).');

  const asset = await deps.db.marketingAsset.create({
    data: {
      name: a.name ?? null,
      type: a.type,
      source: a.source,
      url: a.url,
      storageKey: a.storageKey ?? null,
      externalId: a.externalId ?? null,
      mimeType: a.mimeType,
      sizeBytes: a.sizeBytes,
      width: a.width ?? null,
      height: a.height ?? null,
      durationSec: a.durationSec ?? null,
      checksum: a.checksum ?? null,
      altText: a.altText ?? null,
      tags: a.tags,
      campaignId: a.campaignId ?? null,
      productIds: a.productIds,
      ...ratioFields(a.width, a.height),
      status: 'DRAFT',
      createdById: actor.userId,
    },
  });
  return { asset, warnings };
}

const LINKABLE_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];

/** Idempotent: linking the same product document twice returns the existing
 * asset (`created: false`). */
export async function linkProductDocument(
  documentId: string,
  options: { name?: string; altText?: string; tags?: string[]; campaignId?: string },
  actor: Actor,
  deps: AssetDeps = defaultAssetDeps
) {
  requireRole(actor, 'draft');
  const opts = parse(z.object({ ...common }).omit({ productIds: true }).strict(), options);

  const doc = await deps.readDocument(documentId);
  if (!doc) throw marketingErrors.notFound('Document', documentId);
  if (doc.entityType !== 'PRODUCT') {
    throw marketingErrors.unprocessable('NOT_A_PRODUCT_DOCUMENT', `Document ${documentId} is attached to a ${doc.entityType}, not a product`);
  }
  if (!LINKABLE_IMAGE_TYPES.includes(doc.mimeType.toLowerCase())) {
    throw marketingErrors.unprocessable('UNSUPPORTED_MIME', `${doc.mimeType} cannot be used as a marketing image`);
  }

  const existing = await deps.db.marketingAsset.findFirst({ where: { sourceDocumentId: doc.id, archivedAt: null } });
  if (existing) return { asset: existing, created: false, warnings: [] as string[] };

  const bytes = await deps.readFile(doc.storedPath);
  const probed = probeImageDimensions(bytes);
  if (!probed) throw marketingErrors.unprocessable('UNREADABLE_IMAGE', `Could not read image dimensions from document ${documentId}`);
  blocking(validateMediaMetadata({ type: 'IMAGE', mimeType: doc.mimeType, sizeBytes: doc.size, width: probed.width, height: probed.height }));

  const warnings: string[] = [];
  if (!opts.altText) warnings.push('Image has no alt text (needed for accessible posts).');

  const asset = await deps.db.marketingAsset.create({
    data: {
      name: opts.name ?? doc.filename,
      type: 'IMAGE',
      source: 'ERP_DOCUMENT',
      sourceDocumentId: doc.id,
      // Existing auth-gated core route; storedPath is deliberately not copied.
      url: `/api/documents/${doc.id}/download`,
      storageKey: null,
      mimeType: doc.mimeType.toLowerCase(),
      sizeBytes: doc.size,
      width: probed.width,
      height: probed.height,
      checksum: crypto.createHash('sha256').update(bytes).digest('hex'),
      altText: opts.altText ?? null,
      tags: opts.tags,
      campaignId: opts.campaignId ?? null,
      productIds: [doc.entityId],
      ...ratioFields(probed.width, probed.height),
      status: 'DRAFT',
      createdById: actor.userId,
    },
  });
  return { asset, created: true, warnings };
}

// =============================================================================
// Read / update / archive
// =============================================================================

export async function getAsset(id: string, actor: Actor, deps: AssetDeps = defaultAssetDeps) {
  requireRole(actor, 'view');
  const asset = await deps.db.marketingAsset.findUnique({ where: { id } });
  if (!asset) throw marketingErrors.notFound('Asset', id);
  return asset;
}

const listSchema = z
  .object({
    type: z.enum(['IMAGE', 'VIDEO', 'AUDIO', 'DOCUMENT']).optional(),
    orientation: z.enum(['SQUARE', 'VERTICAL', 'LANDSCAPE']).optional(),
    aspectRatio: z.string().max(10).optional(),
    source: z.enum(['UPLOAD', 'CANVA', 'CAPCUT', 'AI_GENERATED', 'N8N', 'EXTERNAL_URL', 'ERP_DOCUMENT']).optional(),
    campaignId: z.string().optional(),
    productId: z.string().optional(),
    tag: z.string().optional(),
    includeArchived: z.boolean().default(false),
    page: z.number().int().min(1).default(1),
    pageSize: z.number().int().min(1).max(100).default(DEFAULT_PAGE_SIZE),
  })
  .strict();

export async function listAssets(query: z.input<typeof listSchema>, actor: Actor, deps: AssetDeps = defaultAssetDeps) {
  requireRole(actor, 'view');
  const q = parse(listSchema, query);
  const where: Prisma.MarketingAssetWhereInput = {
    ...(q.type ? { type: q.type } : {}),
    ...(q.orientation ? { orientation: q.orientation } : {}),
    ...(q.aspectRatio ? { aspectRatio: q.aspectRatio } : {}),
    ...(q.source ? { source: q.source } : {}),
    ...(q.campaignId ? { campaignId: q.campaignId } : {}),
    ...(q.productId ? { productIds: { has: q.productId } } : {}),
    ...(q.tag ? { tags: { has: q.tag } } : {}),
    ...(q.includeArchived ? {} : { archivedAt: null }),
  };
  const [items, total] = await Promise.all([
    deps.db.marketingAsset.findMany({ where, orderBy: { createdAt: 'desc' }, ...pageWindow(q.page, q.pageSize) }),
    deps.db.marketingAsset.count({ where }),
  ]);
  return { items, total, page: q.page, pageSize: q.pageSize, totalPages: totalPages(total, q.pageSize) };
}

const updateSchema = z
  .object({
    name: z.string().trim().max(200).nullable().optional(),
    altText: z.string().trim().max(500).nullable().optional(),
    tags: z.array(tag).max(20).optional(),
    campaignId: z.string().trim().min(1).nullable().optional(),
    productIds: z.array(z.string().trim().min(1)).max(20).optional(),
  })
  .strict();

/** Metadata only — the file, URL, source and dimensions are immutable (register a new asset instead). */
export async function updateAsset(id: string, patch: unknown, actor: Actor, deps: AssetDeps = defaultAssetDeps) {
  requireRole(actor, 'draft');
  const p = parse(updateSchema, patch);
  const asset = await deps.db.marketingAsset.findUnique({ where: { id } });
  if (!asset) throw marketingErrors.notFound('Asset', id);
  if (asset.archivedAt) throw marketingErrors.invalidState('Archived assets cannot be edited');
  if (p.productIds) {
    await assertProductsExist(p.productIds, deps);
    const sourceProduct = asset.source === 'ERP_DOCUMENT' ? asset.productIds[0] : null;
    if (sourceProduct && !p.productIds.includes(sourceProduct)) {
      throw marketingErrors.invalidInput('A linked product image must stay tagged with its source product');
    }
  }
  return deps.db.marketingAsset.update({ where: { id }, data: p });
}

/** Soft delete. Refused while a scheduled/approved social post still uses it. */
export async function archiveAsset(id: string, actor: Actor, deps: AssetDeps = defaultAssetDeps) {
  requireRole(actor, 'draft');
  const asset = await deps.db.marketingAsset.findUnique({ where: { id } });
  if (!asset) throw marketingErrors.notFound('Asset', id);
  if (asset.archivedAt) return asset;
  const inUse = await deps.db.socialPost.count({
    where: { mediaAssetIds: { has: id }, status: { in: ['APPROVED', 'SCHEDULED'] } },
  });
  if (inUse > 0) throw marketingErrors.invalidState(`Asset is used by ${inUse} approved/scheduled post(s)`);
  return deps.db.marketingAsset.update({ where: { id }, data: { archivedAt: new Date() } });
}

export async function checkAssetFit(id: string, channel: MarketingChannel, actor: Actor, deps: AssetDeps = defaultAssetDeps) {
  const asset = await getAsset(id, actor, deps);
  const issues = checkAssetForChannel(
    { type: asset.type, width: asset.width, height: asset.height, sizeBytes: asset.sizeBytes, durationSec: asset.durationSec == null ? null : Number(asset.durationSec) },
    channel
  );
  return { fits: !issues.some((i) => i.severity === 'BLOCK'), issues };
}
