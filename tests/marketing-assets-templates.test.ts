import { describe, it, expect, vi } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  classifyAspectRatio,
  probeImageDimensions,
  validateMediaMetadata,
  checkAssetForChannel,
} from '@/marketing/assets/media';
import {
  registerAsset,
  linkProductDocument,
  updateAsset,
  archiveAsset,
  listAssets,
  getAsset,
  checkAssetFit,
  type AssetDeps,
  type CoreDocumentRef,
} from '@/marketing/assets/asset-service';
import { parsePlaceholders, renderTemplate } from '@/marketing/templates/placeholders';
import {
  analyzeTemplate,
  createTemplate,
  updateTemplate,
  setTemplateActive,
  getTemplate,
  listTemplates,
  assertTemplateAssignable,
  templateInputSchema,
  type TemplateDeps,
} from '@/marketing/templates/template-service';
import { MarketingError } from '@/marketing/errors';
import { fakeModel } from './marketing-fixtures';

/**
 * Marketing Phase 8: media asset library and template engine. Pure media and
 * placeholder logic plus services against in-memory fakes; core Document
 * rows and files are read-only fixtures.
 */

const sales = { userId: 'u_sales', role: 'SALES' };
const admin = { userId: 'u_admin', role: 'ADMIN' };

async function expectError(p: Promise<unknown>, code: string, status: number): Promise<MarketingError> {
  const err: MarketingError = await p.then(
    () => {
      throw new Error(`expected ${code}, but the call succeeded`);
    },
    (e: MarketingError) => e
  );
  expect(err, String(err)).toBeInstanceOf(MarketingError);
  expect(err).toMatchObject({ code, httpStatus: status });
  return err;
}

// ---------------------------------------------------------------------------
// Synthetic image headers
// ---------------------------------------------------------------------------
function png(w: number, h: number) {
  const b = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(13, 8);
  b.write('IHDR', 12, 'ascii');
  b.writeUInt32BE(w, 16);
  b.writeUInt32BE(h, 20);
  return b;
}
function jpeg(w: number, h: number) {
  const app0 = Buffer.from([0xff, 0xe0, 0x00, 0x10, ...Buffer.alloc(14)]);
  const sof = Buffer.from([0xff, 0xc0, 0x00, 0x11, 0x08, h >> 8, h & 0xff, w >> 8, w & 0xff, 0x03, ...Buffer.alloc(9)]);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app0, Buffer.from([0xff]) /* fill byte */, sof, Buffer.alloc(8)]);
}
function gif(w: number, h: number) {
  const b = Buffer.alloc(13);
  b.write('GIF89a', 0, 'ascii');
  b.writeUInt16LE(w, 6);
  b.writeUInt16LE(h, 8);
  return b;
}
function webp(kind: 'VP8 ' | 'VP8L' | 'VP8X', w: number, h: number) {
  const b = Buffer.alloc(40);
  b.write('RIFF', 0, 'ascii');
  b.writeUInt32LE(32, 4);
  b.write('WEBP', 8, 'ascii');
  b.write(kind, 12, 'ascii');
  if (kind === 'VP8 ') {
    b.writeUInt16LE(w, 26);
    b.writeUInt16LE(h, 28);
  } else if (kind === 'VP8L') {
    b[20] = 0x2f;
    b.writeUInt32LE(((w - 1) | ((h - 1) << 14)) >>> 0, 21);
  } else {
    b.writeUIntLE(w - 1, 24, 3);
    b.writeUIntLE(h - 1, 27, 3);
  }
  return b;
}

// =============================================================================
describe('aspect ratio classification', () => {
  it.each([
    [1080, 1080, '1:1', 'SQUARE'],
    [1080, 1920, '9:16', 'VERTICAL'],
    [1920, 1080, '16:9', 'LANDSCAPE'],
    [1080, 1350, '4:5', 'VERTICAL'],
    [1200, 628, '1.91:1', 'LANDSCAPE'],
    [1080, 1921, '9:16', 'VERTICAL'], // off-by-one export
    [1000, 1010, '1:1', 'SQUARE'], // within 2%
    [1000, 700, 'custom', 'LANDSCAPE'],
    [300, 1000, 'custom', 'VERTICAL'],
  ])('%ix%i → %s %s', (w, h, label, orientation) => {
    expect(classifyAspectRatio(w, h)).toMatchObject({ label, orientation });
  });

  it('rejects impossible dimensions', () => {
    for (const [w, h] of [[0, 100], [100, -1], [10.5, 10]]) expect(() => classifyAspectRatio(w, h)).toThrow(RangeError);
  });
});

describe('image header probing', () => {
  it('reads PNG, JPEG, GIF and all three WebP variants', () => {
    expect(probeImageDimensions(png(1080, 1350))).toEqual({ width: 1080, height: 1350, format: 'png' });
    expect(probeImageDimensions(jpeg(1920, 1080))).toEqual({ width: 1920, height: 1080, format: 'jpeg' });
    expect(probeImageDimensions(gif(640, 480))).toEqual({ width: 640, height: 480, format: 'gif' });
    expect(probeImageDimensions(webp('VP8 ', 800, 600))).toEqual({ width: 800, height: 600, format: 'webp' });
    expect(probeImageDimensions(webp('VP8L', 1080, 1920))).toEqual({ width: 1080, height: 1920, format: 'webp' });
    expect(probeImageDimensions(webp('VP8X', 4000, 3000))).toEqual({ width: 4000, height: 3000, format: 'webp' });
  });

  it('returns null for unknown or truncated data', () => {
    expect(probeImageDimensions(Buffer.from('%PDF-1.7 ...'))).toBeNull();
    expect(probeImageDimensions(png(10, 10).subarray(0, 12))).toBeNull();
    expect(probeImageDimensions(Buffer.from([0xff, 0xd8, 0x00, 0x00]))).toBeNull();
  });
});

describe('media validation', () => {
  it('checks mime, size, resolution and duration per type', () => {
    const codes = (m: Parameters<typeof validateMediaMetadata>[0]) => validateMediaMetadata(m).map((i) => i.code);
    expect(codes({ type: 'IMAGE', mimeType: 'image/png', sizeBytes: 500_000, width: 1080, height: 1080 })).toEqual([]);
    expect(codes({ type: 'IMAGE', mimeType: 'image/heic', sizeBytes: 1, width: 1080, height: 1080 })).toEqual(['UNSUPPORTED_MIME']);
    expect(codes({ type: 'IMAGE', mimeType: 'image/png', sizeBytes: 11 * 1024 * 1024, width: 1080, height: 1080 })).toEqual(['FILE_TOO_LARGE']);
    expect(codes({ type: 'IMAGE', mimeType: 'image/png', sizeBytes: 1 })).toEqual(['MISSING_DIMENSIONS']);
    expect(codes({ type: 'IMAGE', mimeType: 'image/png', sizeBytes: 1, width: 150, height: 150 })).toEqual(['RESOLUTION_TOO_LOW']);
    expect(codes({ type: 'VIDEO', mimeType: 'video/mp4', sizeBytes: 1, width: 1080, height: 1920 })).toEqual(['MISSING_DURATION']);
    expect(codes({ type: 'VIDEO', mimeType: 'video/mp4', sizeBytes: 1, width: 1080, height: 1920, durationSec: 4000 })).toEqual(['DURATION_TOO_LONG']);
    expect(codes({ type: 'DOCUMENT', mimeType: 'application/pdf', sizeBytes: 1000 })).toEqual([]);
  });

  it('checks placement fit per channel', () => {
    const fit = (a: Parameters<typeof checkAssetForChannel>[0], c: Parameters<typeof checkAssetForChannel>[1]) =>
      checkAssetForChannel(a, c).map((i) => `${i.severity}:${i.code}`);
    expect(fit({ type: 'VIDEO', width: 1080, height: 1920, sizeBytes: 1e7, durationSec: 30 }, 'TIKTOK')).toEqual([]);
    expect(fit({ type: 'VIDEO', width: 1920, height: 1080, durationSec: 30 }, 'TIKTOK')).toEqual(['BLOCK:ASPECT_RATIO_NOT_SUPPORTED']);
    expect(fit({ type: 'VIDEO', width: 720, height: 1280, durationSec: 30 }, 'TIKTOK')).toEqual(['WARN:BELOW_RECOMMENDED_RESOLUTION']);
    expect(fit({ type: 'IMAGE', width: 1080, height: 1920 }, 'INSTAGRAM')).toEqual(['BLOCK:ASPECT_RATIO_NOT_SUPPORTED']);
    expect(fit({ type: 'IMAGE', width: 1920, height: 1080 }, 'FACEBOOK')).toEqual([]);
    expect(fit({ type: 'IMAGE', width: 500, height: 500 }, 'FACEBOOK')).toEqual(['BLOCK:RESOLUTION_TOO_LOW']);
    expect(fit({ type: 'AUDIO' }, 'INSTAGRAM')).toEqual(['BLOCK:TYPE_NOT_SUPPORTED_ON_CHANNEL']);
  });
});

// =============================================================================
describe('asset service', () => {
  function setup() {
    const marketingAsset = fakeModel('asset', { archivedAt: null, campaignId: null });
    const socialPost = fakeModel('post');
    const documents: Record<string, CoreDocumentRef> = Object.freeze({
      doc_img: { id: 'doc_img', entityType: 'PRODUCT', entityId: 'p1', filename: 'oven.png', storedPath: 'products/2026/abc.png', mimeType: 'image/png', size: 420_000 },
      doc_pdf: { id: 'doc_pdf', entityType: 'PRODUCT', entityId: 'p1', filename: 'spec.pdf', storedPath: 'products/spec.pdf', mimeType: 'application/pdf', size: 1000 },
      doc_inv: { id: 'doc_inv', entityType: 'INVOICE', entityId: 'inv1', filename: 'x.png', storedPath: 'inv/x.png', mimeType: 'image/png', size: 1000 },
      doc_bad: { id: 'doc_bad', entityType: 'PRODUCT', entityId: 'p1', filename: 'bad.png', storedPath: 'bad.png', mimeType: 'image/png', size: 10 },
    }) as never;
    const files: Record<string, Buffer> = { 'products/2026/abc.png': png(1080, 1350), 'bad.png': Buffer.from('garbage') };
    const readFile = vi.fn(async (p: string) => {
      if (!files[p]) throw new Error('ENOENT');
      return Buffer.from(files[p]); // copy: service must not be able to mutate the fixture
    });
    const deps: AssetDeps = {
      db: { marketingAsset, socialPost } as never,
      readDocument: vi.fn(async (id: string) => documents[id] ?? null),
      productExists: vi.fn(async (id: string) => ['p1', 'p2'].includes(id)),
      readFile,
    };
    return { deps, marketingAsset, socialPost, readFile, files };
  }

  const video = {
    type: 'VIDEO',
    source: 'CAPCUT',
    url: 'https://cdn.example.com/reel.mp4',
    externalId: 'capcut_123',
    mimeType: 'video/mp4',
    sizeBytes: 25_000_000,
    width: 1080,
    height: 1920,
    durationSec: 28,
    productIds: ['p1'],
  };

  it('registers with classification, DRAFT status and warnings', async () => {
    const s = setup();
    const { asset, warnings } = await registerAsset(video, sales, s.deps);
    expect(asset).toMatchObject({ aspectRatio: '9:16', orientation: 'VERTICAL', status: 'DRAFT', createdById: 'u_sales', source: 'CAPCUT' });
    expect(warnings).toEqual([]);
    const img = await registerAsset(
      { type: 'IMAGE', source: 'CANVA', url: 'https://x.co/a.png', mimeType: 'image/png', sizeBytes: 1000, width: 1080, height: 1080 },
      sales,
      s.deps
    );
    expect(img.warnings[0]).toMatch(/alt text/);
  });

  it('rejects invalid media, http URLs, unknown products and duplicates', async () => {
    const s = setup();
    await expectError(registerAsset({ ...video, durationSec: undefined }, sales, s.deps), 'ASSET_INVALID', 422);
    await expectError(registerAsset({ ...video, url: 'http://insecure.example.com/a.mp4' }, sales, s.deps), 'INVALID_INPUT', 400);
    await expectError(registerAsset({ ...video, productIds: ['nope'] }, sales, s.deps), 'INVALID_INPUT', 400);
    await expectError(registerAsset({ ...video, source: 'ERP_DOCUMENT' }, sales, s.deps), 'INVALID_INPUT', 400);

    const checksum = 'a'.repeat(64);
    await registerAsset({ ...video, checksum }, sales, s.deps);
    const dup = await expectError(registerAsset(video, sales, s.deps), 'DUPLICATE', 409);
    expect(dup.details).toMatchObject({ existingId: 'asset_1' });
    await expectError(registerAsset({ ...video, externalId: 'other', checksum: checksum.toUpperCase() }, sales, s.deps), 'DUPLICATE', 409);
    await expectError(registerAsset(video, { userId: 'x', role: 'GUEST' }, s.deps), 'FORBIDDEN', 403);
  });

  it('links a product image read-only: reads the file, never copies or stores its path', async () => {
    const s = setup();
    const before = Buffer.from(s.files['products/2026/abc.png']);
    const { asset, created } = await linkProductDocument('doc_img', { altText: 'Tuscan oven' }, sales, s.deps);
    expect(created).toBe(true);
    expect(asset).toMatchObject({
      source: 'ERP_DOCUMENT',
      sourceDocumentId: 'doc_img',
      url: '/api/documents/doc_img/download',
      storageKey: null,
      type: 'IMAGE',
      width: 1080,
      height: 1350,
      aspectRatio: '4:5',
      orientation: 'VERTICAL',
      productIds: ['p1'],
      checksum: crypto.createHash('sha256').update(before).digest('hex'),
      name: 'oven.png',
    });
    expect(JSON.stringify(asset)).not.toContain('products/2026/abc.png');
    expect(s.readFile).toHaveBeenCalledWith('products/2026/abc.png');
    expect(s.files['products/2026/abc.png'].equals(before)).toBe(true);

    const again = await linkProductDocument('doc_img', {}, sales, s.deps);
    expect(again).toMatchObject({ created: false, asset: { id: asset.id } });
    expect(s.readFile).toHaveBeenCalledTimes(1);
  });

  it('refuses non-product documents, non-images and unreadable files', async () => {
    const s = setup();
    await expectError(linkProductDocument('doc_inv', {}, sales, s.deps), 'NOT_A_PRODUCT_DOCUMENT', 422);
    await expectError(linkProductDocument('doc_pdf', {}, sales, s.deps), 'UNSUPPORTED_MIME', 422);
    await expectError(linkProductDocument('doc_bad', {}, sales, s.deps), 'UNREADABLE_IMAGE', 422);
    await expectError(linkProductDocument('missing', {}, sales, s.deps), 'NOT_FOUND', 404);
    expect(s.marketingAsset.rows.size).toBe(0);
  });

  it('updates metadata only; linked images keep their source product', async () => {
    const s = setup();
    const { asset } = await linkProductDocument('doc_img', {}, sales, s.deps);
    const updated = await updateAsset(asset.id, { altText: 'Oven', tags: ['fall'], productIds: ['p1', 'p2'] }, sales, s.deps);
    expect(updated).toMatchObject({ altText: 'Oven', tags: ['fall'], productIds: ['p1', 'p2'] });
    await expectError(updateAsset(asset.id, { productIds: ['p2'] }, sales, s.deps), 'INVALID_INPUT', 400);
    await expectError(updateAsset(asset.id, { url: 'https://evil.example.com' }, sales, s.deps), 'INVALID_INPUT', 400);
  });

  it('archives unless a scheduled/approved post uses it; list hides archived', async () => {
    const s = setup();
    const a = (await registerAsset(video, sales, s.deps)).asset;
    const b = (await registerAsset({ ...video, externalId: 'capcut_2' }, sales, s.deps)).asset;
    await s.socialPost.create({ data: { mediaAssetIds: [a.id], status: 'SCHEDULED' } });
    await expectError(archiveAsset(a.id, sales, s.deps), 'INVALID_STATE', 409);

    const archived = await archiveAsset(b.id, sales, s.deps);
    expect(archived.archivedAt).toBeInstanceOf(Date);
    await expectError(updateAsset(b.id, { name: 'x' }, sales, s.deps), 'INVALID_STATE', 409);
    expect((await listAssets({}, sales, s.deps)).items.map((x) => x.id)).toEqual([a.id]);
    expect((await listAssets({ includeArchived: true }, sales, s.deps)).total).toBe(2);
  });

  it('lists by orientation/product/type and checks channel fit', async () => {
    const s = setup();
    const reel = (await registerAsset(video, sales, s.deps)).asset;
    await linkProductDocument('doc_img', {}, sales, s.deps);
    expect((await listAssets({ orientation: 'VERTICAL', type: 'VIDEO' }, sales, s.deps)).total).toBe(1);
    expect((await listAssets({ productId: 'p1' }, sales, s.deps)).total).toBe(2);
    expect((await listAssets({ aspectRatio: '4:5' }, sales, s.deps)).total).toBe(1);
    expect(await checkAssetFit(reel.id, 'TIKTOK', sales, s.deps)).toEqual({ fits: true, issues: [] });
    expect((await checkAssetFit(reel.id, 'FACEBOOK', sales, s.deps)).fits).toBe(true);
    await expectError(getAsset('nope', sales, s.deps), 'NOT_FOUND', 404);
  });
});

// =============================================================================
describe('placeholder parsing & rendering', () => {
  it('parses unique names in order, allowing inner whitespace', () => {
    const r = parsePlaceholders('{{product_name}} now {{ price }}! {{product_name}} — {{cta_text}}');
    expect(r.placeholders).toEqual(['product_name', 'price', 'cta_text']);
    expect(r.occurrences).toHaveLength(4);
    expect(r.errors).toEqual([]);
  });

  it('reports invalid names and unbalanced braces', () => {
    expect(parsePlaceholders('{{ProductName}} {{ }} {{price-1}}').errors.map((e) => e.code)).toEqual(['INVALID_NAME', 'INVALID_NAME', 'INVALID_NAME']);
    for (const bad of ['{{price}', 'price}}', '{{{price}}}', 'a {{ b']) {
      expect(parsePlaceholders(bad).errors.map((e) => e.code), bad).toContain('UNBALANCED_BRACES');
    }
    expect(parsePlaceholders('No placeholders, just {single} braces.').errors).toEqual([]);
  });

  it('renders with typed formatting, required/optional handling and limits', () => {
    const body = '{{product_name}}: {{promo_price}} ({{discount_pct}} off, was {{price}}) {{hashtags}} {{disclaimer}}';
    const ok = renderTemplate(
      body,
      { product_name: 'Tuscan Oven', promo_price: 2124.15, discount_pct: 15, price: 2499, hashtags: ['#Oven', '#Pizza'] },
      [{ key: 'disclaimer', required: false, custom: false }]
    );
    expect(ok.text).toBe('Tuscan Oven: $2,124.15 (15% off, was $2,499.00) #Oven #Pizza ');
    expect(ok.errors).toEqual([]);

    const missing = renderTemplate('{{product_name}} {{cta_text}}', { product_name: 'Oven' });
    expect(missing.missing).toEqual(['cta_text']);
    expect(missing.errors).toContain('Missing required value(s): cta_text');

    expect(renderTemplate('{{cta_text}}', { cta_text: 'x'.repeat(41) }).errors[0]).toMatch(/max 40/);
  });

  it('values cannot inject placeholders', () => {
    const r = renderTemplate('{{product_name}} {{price}}', { product_name: 'Oven {{price}}', price: 10 });
    expect(r.text).toBe('Oven { {price} } $10.00');
  });
});

// =============================================================================
describe('template registry', () => {
  function setup() {
    const marketingTemplate = fakeModel('tpl');
    const marketingCampaign = fakeModel('cmp');
    const deps: TemplateDeps = { db: { marketingTemplate, marketingCampaign } as never };
    return { deps, marketingTemplate, marketingCampaign };
  }

  const igPost = {
    name: 'IG product promo',
    kind: 'SOCIAL_POST',
    channel: 'INSTAGRAM',
    body: '{{discount_badge}} {{product_name}} — now {{promo_price}}. {{cta_text}} {{hashtags}}',
    variables: [{ key: 'hashtags', required: false }],
  };

  it('ADMIN creates a ready template; placeholders are stored', async () => {
    const s = setup();
    const { template, analysis } = await createTemplate(igPost, admin, s.deps);
    expect(analysis).toMatchObject({ ready: true, readiness: [] });
    expect(template).toMatchObject({
      active: true,
      provider: 'INTERNAL',
      placeholders: ['discount_badge', 'product_name', 'promo_price', 'cta_text', 'hashtags'],
      createdById: 'u_admin',
    });
    await expectError(createTemplate(igPost, sales, s.deps), 'FORBIDDEN', 403);
  });

  it('rejects structurally invalid definitions', async () => {
    const s = setup();
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ ...igPost, body: '{{product_name}} {{cta_text}} {{warranty_years}}' }, 'not a built-in placeholder'],
      [{ ...igPost, body: '{{product_name}} {{cta_text}' }, 'Unbalanced'],
      [{ ...igPost, body: '' }, 'need a body'],
      [{ ...igPost, provider: 'CANVA' }, 'externalTemplateId'],
      [{ ...igPost, variables: [{ key: 'price', custom: true }] }, 'shadows a built-in'],
      [{ ...igPost, variables: [{ key: 'cta_text' }, { key: 'cta_text' }] }, 'declared twice'],
    ];
    for (const [input, msg] of cases) {
      const err = await expectError(createTemplate(input, admin, s.deps), 'TEMPLATE_INVALID', 422);
      expect(err.message, JSON.stringify(input)).toContain(msg);
    }
    await expectError(createTemplate({ ...igPost, channel: 'WHATSAPP' }, admin, s.deps), 'INVALID_INPUT', 400);
    expect(s.marketingTemplate.rows.size).toBe(0);
  });

  it('accepts declared custom placeholders and warns on unused declarations', () => {
    const a = analyzeTemplate(
      templateInputSchema.parse({
        ...igPost,
        body: '{{product_name}} {{cta_text}} {{warranty_years}}',
        variables: [{ key: 'warranty_years', custom: true, maxLength: 3 }, { key: 'disclaimer', required: false }],
      })
    );
    expect(a.structural).toEqual([expect.objectContaining({ code: 'UNUSED_DECLARATION', severity: 'WARN' })]);
    expect(a.ready).toBe(true);
  });

  it('saves a draft missing required fields but refuses to assign it', async () => {
    const s = setup();
    const { template, analysis } = await createTemplate({ ...igPost, body: 'Just {{product_name}}' }, admin, s.deps);
    expect(analysis.ready).toBe(false);
    const err = await expectError(assertTemplateAssignable(template.id, { channel: 'INSTAGRAM' }, sales, s.deps), 'TEMPLATE_NOT_READY', 422);
    expect(err.message).toContain('{{cta_text}}');
  });

  it('design templates also require a product image slot', () => {
    const a = analyzeTemplate(templateInputSchema.parse({ ...igPost, kind: 'DESIGN' }));
    expect(a.readiness.map((r) => r.message)).toEqual(['DESIGN templates need {{product_image}}']);
  });

  it('external (Canva/CapCut) templates take placeholders from declarations and must be unique', async () => {
    const s = setup();
    const canva = {
      name: 'Canva story',
      kind: 'DESIGN',
      provider: 'CANVA',
      channel: 'INSTAGRAM',
      externalTemplateId: 'DAF123',
      variables: [{ key: 'product_name' }, { key: 'product_image' }, { key: 'cta_text' }],
    };
    const { template, analysis } = await createTemplate(canva, admin, s.deps);
    expect(analysis.ready).toBe(true);
    expect(template.placeholders).toEqual(['product_name', 'product_image', 'cta_text']);
    await expectError(createTemplate({ ...canva, name: 'dup' }, admin, s.deps), 'DUPLICATE', 409);
    await updateTemplate(template.id, { ...canva, name: 'Canva story v2' }, admin, s.deps); // same id: not a duplicate of itself
  });

  it('assignment checks channel, active flag, discount approval and brand', async () => {
    const s = setup();
    const { template } = await createTemplate({ ...igPost, brandProfileId: 'bp1' }, admin, s.deps);
    const noDiscount = await s.marketingCampaign.create({ data: { discountPct: null, brandProfileId: 'bp1', channels: ['INSTAGRAM'] } });
    const discounted = await s.marketingCampaign.create({ data: { discountPct: 15, brandProfileId: 'bp1', channels: ['INSTAGRAM'] } });
    const otherBrand = await s.marketingCampaign.create({ data: { discountPct: 15, brandProfileId: 'bp2', channels: ['INSTAGRAM'] } });

    expect((await assertTemplateAssignable(template.id, { channel: 'INSTAGRAM', campaignId: discounted.id }, sales, s.deps)).placeholders).toContain(
      'discount_badge'
    );

    const d = await expectError(assertTemplateAssignable(template.id, { channel: 'INSTAGRAM', campaignId: noDiscount.id }, sales, s.deps), 'TEMPLATE_NOT_READY', 422);
    expect(d.details).toEqual([expect.objectContaining({ code: 'DISCOUNT_NOT_APPROVED' })]);

    const c = await expectError(assertTemplateAssignable(template.id, { channel: 'TIKTOK' }, sales, s.deps), 'TEMPLATE_NOT_READY', 422);
    expect(c.details).toEqual([expect.objectContaining({ code: 'CHANNEL_MISMATCH' })]);

    const b = await expectError(assertTemplateAssignable(template.id, { channel: 'INSTAGRAM', campaignId: otherBrand.id }, sales, s.deps), 'TEMPLATE_NOT_READY', 422);
    expect(b.details).toEqual([expect.objectContaining({ code: 'BRAND_MISMATCH' })]);

    await setTemplateActive(template.id, false, admin, s.deps);
    const i = await expectError(assertTemplateAssignable(template.id, { channel: 'INSTAGRAM', campaignId: discounted.id }, sales, s.deps), 'TEMPLATE_NOT_READY', 422);
    expect(i.details).toEqual([expect.objectContaining({ code: 'INACTIVE' })]);
    await expectError(assertTemplateAssignable(template.id, { channel: 'INSTAGRAM', campaignId: 'nope' }, sales, s.deps), 'NOT_FOUND', 404);
  });

  it('get / list / update', async () => {
    const s = setup();
    const { template } = await createTemplate(igPost, admin, s.deps);
    await createTemplate({ ...igPost, name: 'TikTok reel', kind: 'VIDEO', channel: 'TIKTOK', body: '{{product_name}} {{cta_text}}' }, admin, s.deps);
    expect((await getTemplate(template.id, sales, s.deps)).analysis.ready).toBe(true);
    expect((await listTemplates({ channel: 'TIKTOK' }, sales, s.deps)).total).toBe(1);
    await setTemplateActive(template.id, false, admin, s.deps);
    expect((await listTemplates({}, sales, s.deps)).total).toBe(1);
    expect((await listTemplates({ includeInactive: true }, sales, s.deps)).total).toBe(2);

    const { template: updated } = await updateTemplate(template.id, { ...igPost, body: '{{product_name}} {{cta_text}}' }, admin, s.deps);
    expect(updated.placeholders).toEqual(['product_name', 'cta_text']);
    await expectError(updateTemplate(template.id, { ...igPost, body: '{{oops}' }, admin, s.deps), 'TEMPLATE_INVALID', 422);
    await expectError(updateTemplate('nope', igPost, admin, s.deps), 'NOT_FOUND', 404);
  });
});

// =============================================================================
describe('isolation', () => {
  it('asset and template services write only marketing tables and never write core documents/files', () => {
    for (const dir of ['assets', 'templates']) {
      const full = path.resolve(__dirname, '../src/marketing', dir);
      for (const file of fs.readdirSync(full)) {
        const src = fs.readFileSync(path.join(full, file), 'utf8');
        const writes = [...src.matchAll(/\.(\w+)\.(create|createMany|update|updateMany|upsert|delete|deleteMany)\(/g)].map((m) => m[1]);
        expect(writes.every((m) => m.startsWith('marketing')), `${file}: ${writes}`).toBe(true);
        expect(src, file).not.toMatch(/saveUploadedFile|deleteStoredFile|writeFile|copyFile|rename\(|unlink/);
      }
    }
  });
});
