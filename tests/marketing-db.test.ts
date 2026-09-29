import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import path from 'node:path';
import type { TestDb } from './test-db';
import { startTestDb } from './test-db';

/**
 * Marketing module against a REAL Postgres (embedded, local only — never
 * production) with the real migrations applied, including
 * 20260928150000_marketing_automation. Verifies what the in-memory fakes
 * can't: unique indexes, idempotency keys, the scene-order index,
 * cascades/Restrict, JSONB round-trips, nested writes, and that consent +
 * messaging read the CRM and send only through the core communications
 * service.
 *
 * Only the LLM, the stock/margin safeguard checks, and the outbound
 * email/WhatsApp/n8n transports are stubbed.
 */

const ROOT = path.resolve(__dirname, '..');

type Mods = {
  brand: typeof import('../src/marketing/content/brand-profile');
  engine: typeof import('../src/marketing/campaigns/engine');
  pipeline: typeof import('../src/marketing/ai/pipeline');
  provider: typeof import('../src/marketing/ai/provider');
  aiAudit: typeof import('../src/marketing/ai/audit');
  video: typeof import('../src/marketing/videos/video-service');
  post: typeof import('../src/marketing/publishing/post-service');
  dispatch: typeof import('../src/marketing/publishing/dispatch');
  pubDeps: typeof import('../src/marketing/publishing/deps');
  audience: typeof import('../src/marketing/audiences/audience-service');
  messaging: typeof import('../src/marketing/audiences/messaging');
  fixtures: typeof import('./marketing-fixtures');
};

describe('marketing module on a real database', () => {
  let db: TestDb;
  let m: Mods;
  let brandCtx: Awaited<ReturnType<Mods['brand']['createBrandProfile']>>;

  beforeAll(async () => {
    db = await startTestDb();
    process.env.DATABASE_URL = db.url; // before any module that imports '@/lib/prisma'
    process.env.MARKETING_PUBLIC_BASE_URL = 'https://crm.example.com';
    process.env.MARKETING_UNSUBSCRIBE_SECRET = 'u'.repeat(40);
    process.env.MARKETING_MEDIA_URL_SECRET = 'm'.repeat(40);
    m = {
      brand: await import('../src/marketing/content/brand-profile'),
      engine: await import('../src/marketing/campaigns/engine'),
      pipeline: await import('../src/marketing/ai/pipeline'),
      provider: await import('../src/marketing/ai/provider'),
      aiAudit: await import('../src/marketing/ai/audit'),
      video: await import('../src/marketing/videos/video-service'),
      post: await import('../src/marketing/publishing/post-service'),
      dispatch: await import('../src/marketing/publishing/dispatch'),
      pubDeps: await import('../src/marketing/publishing/deps'),
      audience: await import('../src/marketing/audiences/audience-service'),
      messaging: await import('../src/marketing/audiences/messaging'),
      fixtures: await import('./marketing-fixtures'),
    };
    brandCtx = await m.brand.createBrandProfile(m.fixtures.brandInput, 'u_admin', db.prisma);
  }, 120000);

  afterAll(async () => {
    await db?.stop();
  });

  const P = () => db.prisma;
  const sales = { userId: 'u_sales', role: 'SALES' };
  const admin = { userId: 'u_admin', role: 'ADMIN' };
  const pass = {
    checkInventory: async (id: string) => ({
      productId: id, verdict: 'PASS' as const, issues: [], trackInventory: true, onHand: 10, draftCommitted: 0, available: 10, requiredMinimum: 3, reorderPoint: 0,
    }),
    checkMargin: async (id: string, pct: number) => ({
      productId: id, verdict: 'PASS' as const, issues: [], listPrice: 2499, discountPct: pct, promoPrice: 2124.15, unitCost: 1000,
      costSource: 'purchase_history' as const, marginPct: 52.9, minMarginPct: 25, maxDiscountPct: 46.6,
    }),
  };
  const code = async (p: Promise<unknown>) => p.then(() => 'OK', (e: { code?: string }) => e.code ?? String(e));

  // ===========================================================================
  it('the committed migrations produce exactly the Prisma schema', () => {
    // --exit-code: 0 = no drift, 2 = drift (execFileSync throws).
    const out = execFileSync(
      'npx',
      ['prisma@5.22.0', 'migrate', 'diff', '--from-url', `"${db.url}"`, '--to-schema-datamodel', 'prisma/schema.prisma', '--exit-code'],
      { cwd: ROOT, env: { ...process.env, DATABASE_URL: db.url }, stdio: 'pipe', shell: true }
    ).toString();
    expect(out).toMatch(/No difference detected|^\s*$/);
  }, 120000);

  // ===========================================================================
  it('brand profiles: nested locale/term writes and single default', async () => {
    const second = await m.brand.createBrandProfile({ ...m.fixtures.brandInput, name: 'Second', isDefault: true }, 'u_admin', P());
    expect(await P().marketingBrandProfile.count({ where: { isDefault: true } })).toBe(1);
    expect((await P().marketingBrandProfile.findUnique({ where: { id: brandCtx.id } }))!.isDefault).toBe(false);

    const updated = await m.brand.updateBrandProfile(
      second.id,
      { ...m.fixtures.brandInput, name: 'Second', terms: [{ conceptKey: 'oven', EN: { term: 'oven' }, ES: { term: 'horno' } }] },
      P()
    );
    expect(updated.terms.ES.map((t) => t.term)).toEqual(['horno']);
    expect(await P().marketingBrandTerm.count({ where: { brandProfileId: second.id } })).toBe(2);
    expect(await P().marketingBrandLocale.count({ where: { brandProfileId: second.id } })).toBe(2);
    expect(await code(P().marketingBrandLocale.create({ data: { brandProfileId: second.id, language: 'EN', voice: 'v', tone: 't' } }))).toBe('P2002');
  });

  // ===========================================================================
  it('campaign engine: one transaction, nested content, AI audit rows', async () => {
    const strategy = {
      name: 'Fall Pizza Season',
      summary: { en: 'Promote the oven for fall.', es: 'Promociona el horno para el otoño.' },
      objectives: [{ title: 'Sell ovens', description: 'd', kpi: { metric: 'conversions', target: 10, unit: 'orders' }, timeframeDays: 30 }],
      audienceSegments: [{ name: 'Chefs', description: 'd', channels: ['INSTAGRAM'], messagingAngle: { en: 'Pizza nights.', es: 'Noches de pizza.' } }],
      recommendedChannels: [{ channel: 'INSTAGRAM', rationale: 'Visual', budgetSharePct: 100 }],
      postConcepts: [{ channel: 'INSTAGRAM', format: 'REEL', hook: { en: 'Flame to slice', es: 'De la llama' }, description: { en: 'Bake.', es: 'Hornear.' } }],
    };
    const copy = {
      en: { headline: 'Fall pizza', body: 'Our brick oven, now 10% off. Prices subject to change.', cta: 'Shop', hashtags: ['#BrickOven'] },
      es: { headline: 'Pizza', body: 'Horno de ladrillo con 10% de descuento. Precios sujetos a cambios.', cta: 'Compra', hashtags: [] },
    };
    const adapter = new m.fixtures.ScriptedAdapter((req) => JSON.stringify(req.system.includes('campaign strategy') ? strategy : copy));
    const res = await m.engine.generateCampaignStrategy({ prompt: 'Fall promo', productId: 'p1', proposedDiscountPct: 10 }, { userId: 'u_sales' }, {
      deps: {
        ...m.engine.defaultCampaignDeps,
        db: P(),
        safeguards: pass,
        loadProduct: async (id) => ({ id, sku: 'TUS-48', name: 'Tuscan Oven', description: null, category: null, price: 2499 }),
        getBrand: async () => brandCtx,
        aiContext: { provider: new m.provider.ResilientAIProvider([adapter], { sleep: async () => undefined }), audit: m.aiAudit.prismaMarketingAiAuditSink },
      },
    });
    const row = await P().marketingCampaign.findUnique({ where: { id: res.campaignId }, include: { contents: true } });
    expect(row).toMatchObject({ status: 'DRAFT', productIds: ['p1'], channels: ['INSTAGRAM'] });
    expect(Number(row!.discountPct)).toBe(10);
    expect(row!.contents).toHaveLength(4);
    expect(row!.contents.every((c) => c.status === 'DRAFT' && c.aiGenerated)).toBe(true);
    expect((row!.strategy as { objectives: unknown[] }).objectives).toHaveLength(1);
    expect(await P().marketingAiLog.count({ where: { status: 'SUCCESS' } })).toBe(2);
  });

  // ===========================================================================
  it('video scenes: real (project, order) unique index, two-pass renumbering, cascade', async () => {
    const campaign = await P().marketingCampaign.create({ data: { name: 'Video', status: 'APPROVED', productIds: [] } });
    const deps = { ...m.video.defaultVideoDeps, db: P(), safeguards: pass, getBrand: async () => brandCtx };
    const project = await m.video.createVideoProject({ campaignId: campaign.id, title: 'Reel', targetDurationSec: 30 }, sales, deps);
    for (const t of ['A', 'B', 'C']) await m.video.addScene(project.id, { durationSec: 5, visualCue: t, onScreenText: t }, sales, {}, deps);
    await m.video.addScene(project.id, { durationSec: 5, visualCue: 'Intro', onScreenText: 'Intro', textBox: null }, sales, { position: 1 }, deps);

    const scenes = () => P().videoScene.findMany({ where: { videoProjectId: project.id }, orderBy: { order: 'asc' } });
    const ids = (await scenes()).map((s) => s.id);
    await m.video.moveScene(ids[0], 4, sales, deps);
    await m.video.reorderScenes(project.id, [ids[3], ids[2], ids[1], ids[0]], sales, deps);
    await m.video.removeScene(ids[1], sales, deps);
    const after = await scenes();
    expect(after.map((s) => [s.order, s.onScreenText])).toEqual([
      [1, 'C'],
      [2, 'B'],
      [3, 'Intro'],
    ]);
    expect(after.every((s) => s.textBox === null)).toBe(true); // Prisma.JsonNull reads back as null

    expect(await code(P().videoScene.create({ data: { videoProjectId: project.id, order: 2, durationSec: 1 } }))).toBe('P2002');
    await P().videoProject.delete({ where: { id: project.id } });
    expect(await P().videoScene.count({ where: { videoProjectId: project.id } })).toBe(0);
  });

  // ===========================================================================
  it('social publishing: idempotent scheduling, unique keys, byte-identical retries after JSONB, Restrict', async () => {
    const account = await P().socialAccount.create({ data: { platform: 'INSTAGRAM', externalAccountId: `ig_${crypto.randomUUID()}`, n8nCredentialRef: 'ig-main' } });
    const campaign = await P().marketingCampaign.create({ data: { name: 'Social', status: 'APPROVED', productIds: ['p1'], discountPct: 15, brandProfileId: brandCtx.id } });
    const asset = await P().marketingAsset.create({
      data: { type: 'IMAGE', source: 'CANVA', url: 'https://cdn.example.com/oven.png', mimeType: 'image/png', width: 1080, height: 1350, sizeBytes: 500_000, altText: 'Oven' },
    });
    const content = await P().marketingContent.create({
      data: {
        campaignId: campaign.id, channel: 'INSTAGRAM', type: 'CAPTION', language: 'en', status: 'APPROVED',
        title: 'Fall', body: 'Our brick oven, now 15% off. Prices subject to change.', hashtags: ['#BrickOven'],
      },
    });

    let clock = new Date('2026-09-28T12:00:00Z');
    const bodies: string[] = [];
    const statuses = [503, 202];
    const deps = {
      ...m.pubDeps.defaultPublishingDeps,
      db: P(),
      safeguards: pass,
      getBrand: async () => brandCtx,
      isActiveAdmin: async (id: string) => id === 'u_admin',
      send: vi.fn(async (req: { body: string }) => (bodies.push(req.body), { status: statuses.shift() ?? 202 })),
      webhookUrl: () => 'https://n8n.example.com/webhook/social-publish',
      callbackUrl: () => 'https://crm.example.com/api/marketing/webhooks/n8n',
      signingSecret: () => 'k'.repeat(40),
      now: () => clock,
    };

    const created = await m.post.createSocialPost({ socialAccountId: account.id, campaignId: campaign.id, contentId: content.id, mediaAssetIds: [asset.id] }, sales, deps);
    await m.post.transitionSocialPost(created.id, 'REVIEW', sales, {}, deps);
    await m.post.transitionSocialPost(created.id, 'APPROVED', admin, {}, deps);

    const at = new Date('2026-09-29T15:00:00Z');
    const [a, b] = await Promise.all([
      m.post.schedulePost(created.id, { scheduledFor: at }, admin, deps),
      m.post.schedulePost(created.id, { scheduledFor: at }, admin, deps),
    ]);
    expect(a.job!.id).toBe(b.job!.id);
    expect([a.created, b.created].sort()).toEqual([false, true]);
    expect(await P().marketingSchedule.count({ where: { socialPostId: created.id } })).toBe(1);

    const job = a.job!;
    expect(await code(P().marketingSchedule.create({ data: { jobType: 'SOCIAL_PUBLISH', runAt: at, idempotencyKey: job.idempotencyKey } }))).toBe('P2002');
    const other = await P().socialPost.create({ data: { socialAccountId: account.id, campaignId: campaign.id } });
    expect(await code(P().socialPost.update({ where: { id: other.id }, data: { dispatchJobId: job.id } }))).toBe('P2002');

    // Dispatch: 503 → retry after backoff → 202. The retry body is rebuilt from
    // the JSONB-stored package (key order not preserved by Postgres) and must
    // still be byte-identical.
    clock = new Date('2026-09-29T15:00:01Z');
    expect((await m.dispatch.dispatchDueSocialPosts({}, deps))[0].outcome).toBe('RETRY_SCHEDULED');
    clock = new Date(clock.getTime() + 61_000);
    expect((await m.dispatch.dispatchDueSocialPosts({}, deps))[0].outcome).toBe('DISPATCHED');
    expect(bodies).toHaveLength(2);
    expect(bodies[1]).toBe(bodies[0]);
    const stored = await P().marketingSchedule.findUnique({ where: { id: job.id } });
    expect(stored!.checksum).toBe(JSON.parse(bodies[0]).checksum);

    expect(await m.post.recordPublishResult({ jobId: job.id, status: 'PUBLISHED', externalPostId: 'ig_100' }, deps)).toEqual({ applied: true, phase: 'PUBLISHED' });
    expect(await m.post.recordPublishResult({ jobId: job.id, status: 'PUBLISHED', externalPostId: 'ig_100' }, deps)).toMatchObject({ reason: 'DUPLICATE' });
    expect(await code(P().socialPost.update({ where: { id: other.id }, data: { externalPostId: 'ig_100' } }))).toBe('P2002');

    expect(await code(P().socialAccount.delete({ where: { id: account.id } }))).toBe('P2003'); // Restrict: posts exist
  });

  // ===========================================================================
  it('cascades: deleting a campaign / brand profile never orphans or deletes the wrong rows', async () => {
    const brand = await m.brand.createBrandProfile({ ...m.fixtures.brandInput, name: 'Temp', isDefault: false }, null, P());
    const campaign = await P().marketingCampaign.create({ data: { name: 'Doomed', productIds: [], brandProfileId: brand.id } });
    const content = await P().marketingContent.create({ data: { campaignId: campaign.id, channel: 'FACEBOOK', type: 'POST_COPY', body: 'x' } });
    await P().campaignApproval.create({
      data: { campaignId: campaign.id, targetType: 'CAMPAIGN', targetId: campaign.id, fromStatus: 'DRAFT', toStatus: 'HUMAN_REVIEW', decidedById: 'u' },
    });
    const asset = await P().marketingAsset.create({ data: { type: 'IMAGE', source: 'UPLOAD', url: 'https://x/y.png', campaignId: campaign.id } });
    const acct = await P().socialAccount.create({ data: { platform: 'FACEBOOK', externalAccountId: `fb_${crypto.randomUUID()}` } });
    const post = await P().socialPost.create({ data: { socialAccountId: acct.id, campaignId: campaign.id, contentId: content.id } });
    const sched = await P().marketingSchedule.create({ data: { jobType: 'SOCIAL_PUBLISH', runAt: new Date(), campaignId: campaign.id, socialPostId: post.id } });
    const vp = await P().videoProject.create({ data: { title: 'v', campaignId: campaign.id } });

    await P().marketingCampaign.delete({ where: { id: campaign.id } });
    expect(await P().marketingContent.count({ where: { id: content.id } })).toBe(0); // Cascade
    expect(await P().campaignApproval.count({ where: { campaignId: campaign.id } })).toBe(0); // Cascade
    expect((await P().marketingAsset.findUnique({ where: { id: asset.id } }))!.campaignId).toBeNull(); // SetNull
    expect(await P().socialPost.findUnique({ where: { id: post.id } })).toMatchObject({ campaignId: null, contentId: null });
    expect((await P().marketingSchedule.findUnique({ where: { id: sched.id } }))!.campaignId).toBeNull();
    expect((await P().videoProject.findUnique({ where: { id: vp.id } }))!.campaignId).toBeNull();

    const c2 = await P().marketingCampaign.create({ data: { name: 'Keeps', productIds: [], brandProfileId: brand.id } });
    await P().marketingBrandProfile.delete({ where: { id: brand.id } });
    expect(await P().marketingBrandLocale.count({ where: { brandProfileId: brand.id } })).toBe(0);
    expect(await P().marketingBrandTerm.count({ where: { brandProfileId: brand.id } })).toBe(0);
    expect((await P().marketingCampaign.findUnique({ where: { id: c2.id } }))!.brandProfileId).toBeNull();

    // Required relation: an approval can't point at a campaign that doesn't exist.
    expect(
      await code(P().campaignApproval.create({ data: { campaignId: 'nope', targetType: 'CAMPAIGN', targetId: 'x', fromStatus: 'DRAFT', toStatus: 'DRAFT', decidedById: 'u' } }))
    ).toBe('P2003');
  });

  // ===========================================================================
  it('audiences read CRM consent/timeline; messages go only through the core communications service', async () => {
    const now = new Date('2026-09-28T12:00:00Z');
    const hoursAgo = (h: number) => new Date(now.getTime() - h * 3600_000);
    const site = await P().wordPressSite.create({ data: { name: 'Site', baseUrl: 'https://ctbrickovensupply.example' } });
    const customer = await P().company.create({ data: { name: 'Pizzeria Uno', type: 'CUSTOMER', state: 'CT' } });
    const supplier = await P().company.create({ data: { name: 'Brick Co', type: 'SUPPLIER', state: 'CT' } });
    const closed = await P().company.create({ data: { name: 'Closed LLC', type: 'CUSTOMER', state: 'CT', active: false } });

    const contact = (firstName: string, companyId: string, extra: Record<string, unknown> = {}) =>
      P().contact.create({ data: { firstName, lastName: 'X', companyId, email: `${firstName.toLowerCase()}@example.com`, ...extra } });
    const lead = (contactId: string, consentGiven: boolean, submittedAt: Date) =>
      P().wordPressLead.create({ data: { wordpressSiteId: site.id, contactId, consentGiven, submittedAt, rawData: {} } });
    const inbound = (contactId: string, type: 'EMAIL' | 'WHATSAPP', body: string, occurredAt: Date) =>
      P().communicationLog.create({ data: { contactId, type, direction: 'INBOUND', body, occurredAt } });

    const ana = await contact('Ana', customer.id); // consent → eligible
    await lead(ana.id, true, hoursAgo(100));
    const ben = await contact('Ben', customer.id); // consent false
    await lead(ben.id, false, hoursAgo(100));
    const cal = await contact('Cal', customer.id); // later lead without consent withdraws it
    await lead(cal.id, true, hoursAgo(200));
    await lead(cal.id, false, hoursAgo(50));
    const dee = await contact('Dee', customer.id); // replied STOP after consenting
    await lead(dee.id, true, hoursAgo(100));
    await inbound(dee.id, 'EMAIL', 'STOP', hoursAgo(10));
    await contact('Eve', customer.id); // no consent record at all
    const fay = await contact('Fay', customer.id, { email: null, mobile: '+18605550100' }); // consent, WhatsApp inside 24h
    await lead(fay.id, true, hoursAgo(100));
    await inbound(fay.id, 'WHATSAPP', 'Hi, is the oven in stock?', hoursAgo(2));
    const gus = await contact('Gus', customer.id, { email: null, mobile: '+18605550101' }); // consent, WhatsApp outside 24h
    await lead(gus.id, true, hoursAgo(100));
    await inbound(gus.id, 'WHATSAPP', 'Thanks!', hoursAgo(72));
    const sup = await contact('Sam', supplier.id); // supplier — filtered out by rules
    await lead(sup.id, true, hoursAgo(100));
    const old = await contact('Olga', closed.id); // inactive company — filtered out
    await lead(old.id, true, hoursAgo(100));

    const audDeps = { db: P(), now: () => now };
    const emailAud = await m.audience.createAudience(
      { name: 'CT customers', channel: 'EMAIL', criteria: { companyTypes: ['CUSTOMER'], states: ['ct'] } },
      sales,
      audDeps
    );
    const preview = await m.audience.previewAudience(emailAud.id, sales, audDeps);
    expect(preview.sample.map((s) => s.firstName)).toEqual(['Ana']);
    expect(preview.excluded).toMatchObject({ CONSENT_NOT_GIVEN: 2, OPTED_OUT: 1, NO_CONSENT_RECORD: 1 });
    expect((await P().marketingAudience.findUnique({ where: { id: emailAud.id } }))!.lastSizeCount).toBe(1);

    const waAud = await m.audience.createAudience({ name: 'WA', channel: 'WHATSAPP', criteria: { companyIds: [customer.id] } }, sales, audDeps);
    const wa = await m.audience.resolveAudience(waAud.id, audDeps);
    expect(wa.eligible.map((r) => [r.firstName, r.address])).toEqual([['Fay', '+18605550100']]);
    expect(wa.excluded.OUTSIDE_WHATSAPP_WINDOW).toBe(1);

    // Send through the core service with stubbed transports.
    const campaign = await P().marketingCampaign.create({ data: { name: 'Email', status: 'APPROVED', productIds: [] } });
    const content = await P().marketingContent.create({
      data: { campaignId: campaign.id, channel: 'EMAIL', type: 'EMAIL', language: 'en', status: 'APPROVED', title: 'Fall ovens', body: 'Our oven is back in stock.' },
    });
    const coreTables = ['company', 'contact', 'wordPressLead', 'product', 'salesOrder', 'invoice', 'payment', 'stockLevel'] as const;
    const counts = () => Promise.all(coreTables.map((t) => (P()[t] as unknown as { count: () => Promise<number> }).count()));
    const before = await counts();
    const logsBefore = await P().communicationLog.count({ where: { direction: 'OUTBOUND' } });

    // CommunicationLog.userId is a real FK to User (the fakes never enforced it): send as a real ADMIN.
    const adminUser = await P().user.create({ data: { email: 'admin@example.com', name: 'Admin', passwordHash: 'x', role: 'ADMIN' } });
    const realAdmin = { userId: adminUser.id, role: 'ADMIN' };
    const emailSender = vi.fn(async () => ({ sent: true }));
    const msgDeps = {
      ...m.messaging.defaultMessagingDeps,
      db: P(),
      audience: audDeps,
      safeguards: pass,
      getBrand: async () => brandCtx, // has postalAddress (fixture)
      senderDeps: { emailSender },
      now: () => now,
    };
    const send = (actor: { userId: string; role: string }, deps = msgDeps) =>
      m.messaging.sendCampaignMessage({ campaignId: campaign.id, contentId: content.id, audienceId: emailAud.id }, actor, deps);
    expect(await code(send(sales))).toBe('FORBIDDEN');

    // CAN-SPAM: refused up front (nothing sent) without a postal address or unsubscribe signing.
    expect(await code(send(realAdmin, { ...msgDeps, getBrand: async () => ({ ...brandCtx, postalAddress: null }) }))).toBe('BRAND_ADDRESS_REQUIRED');
    expect(await code(send(realAdmin, { ...msgDeps, unsubscribeLink: () => null }))).toBe('UNSUBSCRIBE_NOT_CONFIGURED');
    expect(emailSender).not.toHaveBeenCalled();

    const first = await send(realAdmin);
    expect(first).toMatchObject({ eligible: 1, attempted: 1, sent: 1, alreadySent: 0, failed: 0 });
    expect(emailSender).toHaveBeenCalledTimes(1);
    const log = await P().communicationLog.findFirst({ where: { direction: 'OUTBOUND', contactId: ana.id } });
    expect(log).toMatchObject({ type: 'EMAIL', status: 'SENT', recipient: 'ana@example.com', templateKey: `marketing:${campaign.id}:${content.id}`, userId: adminUser.id });
    expect(log!.body).toContain('123 Main St, Hartford, CT 06103');
    expect(log!.body).toMatch(/Unsubscribe: https:\/\/crm\.example\.com\/api\/marketing\/public\/unsubscribe\?t=/);
    expect(log!.body).toContain('Or reply STOP.');

    const second = await m.messaging.sendCampaignMessage({ campaignId: campaign.id, contentId: content.id, audienceId: emailAud.id }, realAdmin, msgDeps);
    expect(second).toMatchObject({ sent: 0, alreadySent: 1 });
    expect(emailSender).toHaveBeenCalledTimes(1);
    expect(await P().communicationLog.count({ where: { direction: 'OUTBOUND' } })).toBe(logsBefore + 1);

    // The CRM itself is untouched (the only core writes are the core service's own log + idempotency key).
    expect(await counts()).toEqual(before);
    expect(await P().idempotencyKey.count({ where: { key: { startsWith: 'mkt-msg:' } } })).toBe(1);
    expect(await P().campaignApproval.count({ where: { campaignId: campaign.id, targetType: 'CONTENT' } })).toBe(2);

    // ---- One-click unsubscribe, end to end through the public route ----
    const link = log!.body!.match(/https:\/\/crm\.example\.com\/api\/marketing\/public\/unsubscribe\?t=(\S+)/)!;
    const token = decodeURIComponent(link[1]);
    const { GET, POST } = await import('../src/app/api/marketing/public/unsubscribe/route');
    const { NextRequest } = await import('next/server');
    const url = `http://localhost/api/marketing/public/unsubscribe?t=${encodeURIComponent(token)}`;
    const inboundBefore = await P().communicationLog.count({ where: { contactId: ana.id, direction: 'INBOUND' } });

    const confirm = await GET(new NextRequest(url));
    expect(confirm.status).toBe(200);
    expect(await confirm.text()).toContain('<form method="post">');
    expect(await P().communicationLog.count({ where: { contactId: ana.id, direction: 'INBOUND' } })).toBe(inboundBefore); // GET never mutates

    const form = new URLSearchParams({ t: token });
    const done = await POST(new NextRequest('http://localhost/api/marketing/public/unsubscribe', { method: 'POST', body: form, headers: { 'content-type': 'application/x-www-form-urlencoded' } }));
    expect(done.status).toBe(200);
    const optOut = await P().communicationLog.findFirst({ where: { contactId: ana.id, direction: 'INBOUND', templateKey: 'marketing:unsubscribe' } });
    expect(optOut).toMatchObject({ type: 'EMAIL', companyId: customer.id });

    // Repeat click is idempotent; the CRM-derived consent now excludes Ana.
    await POST(new NextRequest(url, { method: 'POST' }));
    expect(await P().communicationLog.count({ where: { contactId: ana.id, templateKey: 'marketing:unsubscribe' } })).toBe(1);
    const after = await m.audience.resolveAudience(emailAud.id, { db: P(), now: () => new Date() });
    expect(after.eligible).toEqual([]);
    expect(after.excluded.OPTED_OUT).toBe(2);

    // Tampered / foreign tokens are rejected and record nothing.
    const bad = await POST(new NextRequest(`http://localhost/api/marketing/public/unsubscribe?t=${encodeURIComponent(token.slice(0, -2) + 'xx')}`, { method: 'POST' }));
    expect(bad.status).toBe(400);
    expect(await P().communicationLog.count({ where: { templateKey: 'marketing:unsubscribe' } })).toBe(1);
    expect(await counts()).toEqual(before);
  });
});
