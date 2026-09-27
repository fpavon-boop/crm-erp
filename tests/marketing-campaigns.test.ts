import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { generateCampaignStrategy, type CampaignEngineDeps } from '@/marketing/campaigns/engine';
import {
  getCampaign,
  listCampaigns,
  transitionCampaignStatus,
  updateCampaignDetails,
  updateCampaignContent,
  deleteDraftCampaign,
} from '@/marketing/campaigns/service';
import { CampaignError, CampaignSafeguardError } from '@/marketing/campaigns/errors';
import { runMarketingPrompt, MarketingAiError } from '@/marketing/ai/pipeline';
import { ResilientAIProvider, type TextRequest } from '@/marketing/ai/provider';
import type { MarketingAiAuditEntry } from '@/marketing/ai/audit';
import type { InventoryStatus, MarginViability } from '@/marketing/ai/safeguards';
import { makeBrand, ScriptedAdapter } from './marketing-fixtures';

/**
 * Marketing Phase 7: campaign strategy engine + lifecycle services.
 * Mocked DB (in-memory fake with the Prisma calls the services use), mocked
 * safeguards, and the REAL Phase 6 pipeline driven by a scripted LLM.
 */

// =============================================================================
// In-memory Prisma fake
// =============================================================================

type Row = Record<string, any>;

function createFakeDb() {
  const campaigns = new Map<string, Row>();
  const contents = new Map<string, Row>();
  const approvals: Row[] = [];
  let seq = 0;
  const nextId = (p: string) => `${p}_${++seq}`;

  const matches = (row: Row, where: Row = {}) =>
    Object.entries(where).every(([k, cond]) => {
      const v = row[k];
      if (cond && typeof cond === 'object' && !(cond instanceof Date) && !Array.isArray(cond)) {
        if ('in' in cond) return cond.in.includes(v);
        if ('has' in cond) return Array.isArray(v) && v.includes(cond.has);
        if ('contains' in cond) return String(v ?? '').toLowerCase().includes(String(cond.contains).toLowerCase());
        if ('not' in cond) return v !== cond.not;
      }
      return v === cond;
    });

  const apply = (row: Row, data: Row) => {
    for (const [k, v] of Object.entries(data)) {
      row[k] = v && typeof v === 'object' && 'increment' in v ? (row[k] ?? 0) + v.increment : v;
    }
    row.updatedAt = new Date();
  };

  const withIncludes = (c: Row, include?: Row) => ({
    ...c,
    ...(include?.contents ? { contents: [...contents.values()].filter((x) => x.campaignId === c.id).map((x) => ({ ...x })) } : {}),
    ...(include?.approvals ? { approvals: approvals.filter((a) => a.campaignId === c.id).reverse() } : {}),
  });

  const db: Row = {
    marketingCampaign: {
      create: vi.fn(async ({ data, include }: Row) => {
        const { contents: nested, ...rest } = data;
        const c: Row = {
          id: nextId('cmp'),
          approvedById: null,
          approvedAt: null,
          startsAt: null,
          endsAt: null,
          createdAt: new Date(),
          updatedAt: new Date(),
          ...rest,
        };
        campaigns.set(c.id, c);
        for (const ct of nested?.create ?? []) {
          const row: Row = {
            id: nextId('cnt'),
            campaignId: c.id,
            version: 1,
            reviewedById: null,
            reviewedAt: null,
            rejectionReason: null,
            createdAt: new Date(),
            updatedAt: new Date(),
            ...ct,
          };
          contents.set(row.id, row);
        }
        return withIncludes(c, include);
      }),
      findUnique: vi.fn(async ({ where, include }: Row) => {
        const c = campaigns.get(where.id);
        return c ? withIncludes(c, include) : null;
      }),
      findMany: vi.fn(async ({ where, skip = 0, take }: Row) =>
        [...campaigns.values()].filter((c) => matches(c, where)).slice(skip, take ? skip + take : undefined)
      ),
      count: vi.fn(async ({ where }: Row) => [...campaigns.values()].filter((c) => matches(c, where)).length),
      updateMany: vi.fn(async ({ where, data }: Row) => {
        const rows = [...campaigns.values()].filter((c) => matches(c, where));
        rows.forEach((r) => apply(r, data));
        return { count: rows.length };
      }),
      delete: vi.fn(async ({ where }: Row) => {
        campaigns.delete(where.id);
        for (const [id, c] of contents) if (c.campaignId === where.id) contents.delete(id);
      }),
    },
    marketingContent: {
      findUnique: vi.fn(async ({ where, include }: Row) => {
        const c = contents.get(where.id);
        if (!c) return null;
        return { ...c, ...(include?.campaign ? { campaign: { ...campaigns.get(c.campaignId) } } : {}) };
      }),
      update: vi.fn(async ({ where, data }: Row) => {
        const c = contents.get(where.id)!;
        apply(c, data);
        return { ...c };
      }),
      updateMany: vi.fn(async ({ where, data }: Row) => {
        const rows = [...contents.values()].filter((c) => matches(c, where));
        rows.forEach((r) => apply(r, data));
        return { count: rows.length };
      }),
    },
    campaignApproval: {
      create: vi.fn(async ({ data }: Row) => {
        const row = { id: nextId('apr'), createdAt: new Date(), ...data };
        approvals.push(row);
        return row;
      }),
      count: vi.fn(async ({ where }: Row) => approvals.filter((a) => matches(a, where)).length),
    },
  };
  db.$transaction = vi.fn(async (fn: (tx: Row) => unknown) => fn(db));
  return { db, campaigns, contents, approvals };
}

// =============================================================================
// Fixtures
// =============================================================================

type Verdict = 'PASS' | 'WARN' | 'BLOCK';

const inventory = (productId: string, verdict: Verdict = 'PASS'): InventoryStatus => ({
  productId,
  verdict,
  issues:
    verdict === 'PASS'
      ? []
      : [{ code: verdict === 'BLOCK' ? 'INSUFFICIENT_STOCK' : 'AT_OR_BELOW_REORDER_POINT', severity: verdict, message: `stock ${verdict}` }],
  trackInventory: true,
  onHand: verdict === 'BLOCK' ? 1 : 10,
  draftCommitted: 0,
  available: verdict === 'BLOCK' ? 1 : 10,
  requiredMinimum: 3,
  reorderPoint: 0,
});

const margin = (productId: string, verdict: Verdict = 'PASS', discountPct = 10): MarginViability => ({
  productId,
  verdict,
  issues:
    verdict === 'PASS'
      ? []
      : [{ code: verdict === 'BLOCK' ? 'MARGIN_BELOW_MINIMUM' : 'COST_FROM_STANDARD_COST', severity: verdict, message: `margin ${verdict}` }],
  listPrice: 2499,
  discountPct,
  promoPrice: Math.round(2499 * (1 - discountPct / 100) * 100) / 100,
  unitCost: 1187.5,
  costSource: verdict === 'WARN' ? 'standard_cost' : 'purchase_history',
  marginPct: 47.2,
  minMarginPct: 25,
  maxDiscountPct: 36.6,
});

const strategyReply = (overrides: Record<string, unknown> = {}) =>
  JSON.stringify({
    name: 'Fall Pizza Season',
    summary: { en: 'Promote the Tuscan brick oven for fall pizza nights.', es: 'Promociona el horno de ladrillo Tuscan para noches de pizza.' },
    objectives: [
      { title: 'Drive oven sales', description: 'Convert warm leads.', kpi: { metric: 'conversions', target: 12, unit: 'orders' }, timeframeDays: 30 },
    ],
    audienceSegments: [
      {
        name: 'Backyard chefs',
        description: 'Homeowners who entertain outdoors.',
        channels: ['INSTAGRAM', 'FACEBOOK'],
        messagingAngle: { en: 'Pizza nights, reimagined.', es: 'Noches de pizza, reinventadas.' },
      },
    ],
    recommendedChannels: [
      { channel: 'TIKTOK', rationale: 'Reach', budgetSharePct: 10 },
      { channel: 'INSTAGRAM', rationale: 'Visual', budgetSharePct: 45 },
      { channel: 'FACEBOOK', rationale: 'Community', budgetSharePct: 30 },
      { channel: 'EMAIL', rationale: 'Leads', budgetSharePct: 15 },
    ],
    postConcepts: [
      {
        channel: 'INSTAGRAM',
        format: 'REEL',
        hook: { en: 'From flame to slice in 90 seconds', es: 'De la llama a la rebanada en 90 segundos' },
        description: { en: 'Show a pizza baking in the brick oven.', es: 'Muestra una pizza horneándose en el horno de ladrillo.' },
      },
      {
        channel: 'TIKTOK',
        format: 'VIDEO',
        hook: { en: 'Brick oven build timelapse', es: 'Timelapse de la instalación' },
        description: { en: 'Installation timelapse.', es: 'Timelapse de la instalación del horno.' },
      },
    ],
    ...overrides,
  });

const copyReply = JSON.stringify({
  en: { headline: 'Fall pizza season', body: 'Our brick oven, now 10% off. Prices subject to change.', cta: 'Shop now', hashtags: ['#BrickOven'] },
  es: { headline: 'Temporada de pizza', body: 'Horno de ladrillo con 10% de descuento. Precios sujetos a cambios.', cta: 'Compra ya', hashtags: ['#Horno'] },
});

const isStrategy = (req: TextRequest) => req.system.includes('design a marketing campaign strategy');

function setup(
  opts: {
    inventory?: Verdict[];
    margin?: Verdict[];
    reply?: (req: TextRequest, n: number) => string | Error;
    brand?: boolean;
  } = {}
) {
  const fake = createFakeDb();
  const invQueue = [...(opts.inventory ?? [])];
  const marQueue = [...(opts.margin ?? [])];
  const checkInventory = vi.fn(async (id: string) => inventory(id, invQueue.length > 1 ? invQueue.shift()! : invQueue[0] ?? 'PASS'));
  const checkMargin = vi.fn(async (id: string, pct: number) => margin(id, marQueue.length > 1 ? marQueue.shift()! : marQueue[0] ?? 'PASS', pct));
  const adapter = new ScriptedAdapter(opts.reply ?? ((req) => (isStrategy(req) ? strategyReply() : copyReply)));
  const audit: MarketingAiAuditEntry[] = [];
  let n = 0;
  const deps: CampaignEngineDeps = {
    db: fake.db as never,
    safeguards: { checkInventory, checkMargin },
    loadProduct: vi.fn(async (id: string) => ({ id, sku: 'TUS-48', name: 'Tuscan 48" Oven', description: 'Refractory brick dome.', category: 'Ovens', price: 2499 })),
    getBrand: vi.fn(async () => (opts.brand === false ? null : makeBrand())),
    runPrompt: runMarketingPrompt,
    aiContext: {
      provider: new ResilientAIProvider([adapter], { sleep: async () => undefined, random: () => 0 }),
      audit: { record: async (e) => (audit.push(e), `log_${audit.length}`) },
    },
    newId: () => `grp_${++n}`,
    now: () => new Date('2026-09-27T12:00:00Z'),
  };
  return { ...fake, deps, adapter, audit, checkInventory, checkMargin };
}

const actor = { userId: 'u_sales' };
const sales = { userId: 'u_sales', role: 'SALES' };
const admin = { userId: 'u_admin', role: 'ADMIN' };
const input = { prompt: 'Fall promo for our best oven', productId: 'p1', budget: 5000, proposedDiscountPct: 10 };

async function expectCampaignError(p: Promise<unknown>, code: string, status: number): Promise<CampaignError> {
  const err: CampaignError = await p.then(
    () => {
      throw new Error(`expected , but the call succeeded`);
    },
    (e: CampaignError) => e
  );
  expect(err, String(err)).toBeInstanceOf(CampaignError);
  expect(err).toMatchObject({ code, httpStatus: status });
  return err;
}

// =============================================================================
describe('generateCampaignStrategy — safeguard blocking', () => {
  it('blocks on insufficient stock: no AI call, nothing persisted', async () => {
    const s = setup({ inventory: ['BLOCK'] });
    const err = await expectCampaignError(generateCampaignStrategy(input, actor, { deps: s.deps }), 'SAFEGUARD_BLOCKED', 422);
    expect(err).toBeInstanceOf(CampaignSafeguardError);
    expect(err.message).toContain('stock BLOCK');
    expect(s.adapter.requests).toHaveLength(0);
    expect(s.campaigns.size).toBe(0);
    expect(s.db.$transaction).not.toHaveBeenCalled();
  });

  it('blocks when margin at the proposed discount is below 25%', async () => {
    const s = setup({ margin: ['BLOCK'] });
    await expectCampaignError(generateCampaignStrategy(input, actor, { deps: s.deps }), 'SAFEGUARD_BLOCKED', 422);
    expect(s.checkMargin).toHaveBeenCalledWith('p1', 10, expect.anything());
    expect(s.adapter.requests).toHaveLength(0);
    expect(s.campaigns.size).toBe(0);
  });

  it('re-checks safeguards after generation and blocks persisting if stock changed', async () => {
    const s = setup({ inventory: ['PASS', 'BLOCK'] });
    const err = await expectCampaignError(generateCampaignStrategy(input, actor, { deps: s.deps }), 'SAFEGUARD_BLOCKED', 422);
    expect(err.message).toContain('pre-persist');
    expect(s.adapter.requests.length).toBeGreaterThan(0);
    expect(s.campaigns.size).toBe(0);
  });

  it('rejects a discount without a product, and invalid channels, before any work', async () => {
    const s = setup();
    await expectCampaignError(generateCampaignStrategy({ prompt: 'x', proposedDiscountPct: 20 }, actor, { deps: s.deps }), 'INVALID_INPUT', 400);
    await expectCampaignError(generateCampaignStrategy({ prompt: 'x', targetChannels: ['myspace'] }, actor, { deps: s.deps }), 'INVALID_INPUT', 400);
    await expectCampaignError(generateCampaignStrategy({ prompt: '' }, actor, { deps: s.deps }), 'INVALID_INPUT', 400);
    expect(s.checkInventory).not.toHaveBeenCalled();
  });

  it('requires an active brand profile', async () => {
    const s = setup({ brand: false });
    await expectCampaignError(generateCampaignStrategy(input, actor, { deps: s.deps }), 'BRAND_PROFILE_REQUIRED', 412);
    expect(s.adapter.requests).toHaveLength(0);
  });
});

// =============================================================================
describe('generateCampaignStrategy — AI flow and persistence', () => {
  it('persists campaign + bilingual copy + concepts, all DRAFT', async () => {
    const s = setup();
    const res = await generateCampaignStrategy(input, actor, { deps: s.deps });

    const campaign = s.campaigns.get(res.campaignId)!;
    expect(campaign).toMatchObject({
      name: 'Fall Pizza Season',
      status: 'DRAFT',
      productIds: ['p1'],
      discountPct: 10,
      budget: 5000,
      sourcePrompt: 'Fall promo for our best oven',
      brandProfileId: 'bp1',
      createdById: 'u_sales',
      channels: ['TIKTOK', 'INSTAGRAM', 'FACEBOOK', 'EMAIL'],
    });
    expect(campaign.strategy).toMatchObject({ templateKey: 'campaign_strategy', audienceSegments: [{ name: 'Backyard chefs' }] });
    expect(campaign.safeguardSnapshot).toMatchObject({ verdict: 'PASS', discountPct: 10, products: [{ productId: 'p1' }] });

    const rows = [...s.contents.values()];
    expect(rows.every((r) => r.status === 'DRAFT' && r.aiGenerated === true)).toBe(true);

    // Copy for the 3 highest-budget channels only (INSTAGRAM 45, FACEBOOK 30, EMAIL 15), EN + ES each
    const copy = rows.filter((r) => r.type !== 'POST_CONCEPT');
    expect(copy.map((r) => `${r.channel}:${r.language}`).sort()).toEqual(
      ['EMAIL:en', 'EMAIL:es', 'FACEBOOK:en', 'FACEBOOK:es', 'INSTAGRAM:en', 'INSTAGRAM:es'].sort()
    );
    expect(copy.find((r) => r.channel === 'EMAIL')!.type).toBe('EMAIL');
    const ig = copy.filter((r) => r.channel === 'INSTAGRAM');
    expect(ig[0].variantGroupId).toBe(ig[1].variantGroupId);
    expect(ig.find((r) => r.language === 'es')!.body).toContain('Compra ya');

    const concepts = rows.filter((r) => r.type === 'POST_CONCEPT');
    expect(concepts).toHaveLength(4);
    expect(concepts.find((r) => r.language === 'es' && r.channel === 'TIKTOK')!.title).toBe('Timelapse de la instalación');

    expect(res.compliance.strategy?.verdict).toBe('PASS');
    expect(res.warnings).toEqual([]);
    // one strategy + three copy calls, each audited in MarketingAiLog
    expect(s.audit.map((a) => a.templateKey)).toEqual(['campaign_strategy', 'bilingual_copy', 'bilingual_copy', 'bilingual_copy']);
    expect(rows.every((r) => r.aiLogId?.startsWith('log_'))).toBe(true);
  });

  it('sends product facts and approved discount to the AI but never cost or margin', async () => {
    const s = setup();
    await generateCampaignStrategy(input, actor, { deps: s.deps });
    const prompt = s.adapter.requests[0].prompt;
    expect(prompt).toContain('TUS-48');
    expect(prompt).toContain('list price $2499.00; promo price $2249.10');
    expect(prompt).toContain('approved discount: 10%');
    expect(prompt).not.toMatch(/1187|47\.2|unit ?cost|margin/i);
  });

  it('proceeds on WARN (manual cost) and records the warning verdict', async () => {
    const s = setup({ margin: ['WARN'] });
    const res = await generateCampaignStrategy(input, actor, { deps: s.deps });
    expect(res.safeguards.verdict).toBe('WARN');
    expect(s.campaigns.get(res.campaignId)!.safeguardSnapshot.verdict).toBe('WARN');
  });

  it('enforces requested channels via schema: off-list channel is re-asked, then accepted', async () => {
    const s = setup({
      reply: (req, n) => {
        if (!isStrategy(req)) return copyReply;
        return n === 1
          ? strategyReply()
          : strategyReply({
              recommendedChannels: [{ channel: 'INSTAGRAM', rationale: 'Visual', budgetSharePct: 100 }],
              audienceSegments: [
                { name: 'Chefs', description: 'd', channels: ['INSTAGRAM'], messagingAngle: { en: 'Pizza nights.', es: 'Noches de pizza.' } },
              ],
              postConcepts: [JSON.parse(strategyReply()).postConcepts[0]],
            });
      },
    });
    const res = await generateCampaignStrategy({ ...input, targetChannels: ['instagram'] }, actor, { deps: s.deps });
    expect(s.adapter.requests[1].prompt).toContain('Your previous reply was rejected');
    expect(s.adapter.requests[1].prompt).toMatch(/not one of the requested channels/);
    expect(s.campaigns.get(res.campaignId)!.channels).toEqual(['INSTAGRAM']);
  });

  it('strategy failure is fatal: nothing persisted, failure audited', async () => {
    const s = setup({ reply: (req) => (isStrategy(req) ? 'I cannot do that' : copyReply) });
    const err = await generateCampaignStrategy(input, actor, { deps: s.deps }).catch((e) => e);
    expect(err).toBeInstanceOf(MarketingAiError);
    expect(s.campaigns.size).toBe(0);
    expect(s.audit[0]).toMatchObject({ templateKey: 'campaign_strategy', status: 'VALIDATION_FAILED' });
  });

  it('a copy failure for one channel is non-fatal and reported as a warning', async () => {
    const s = setup({ reply: (req) => (isStrategy(req) ? strategyReply() : req.prompt.includes('channel: EMAIL') ? 'nope' : copyReply) });
    const res = await generateCampaignStrategy(input, actor, { deps: s.deps });
    expect(res.warnings).toEqual([expect.stringContaining('EMAIL')]);
    const copyChannels = new Set([...s.contents.values()].filter((r) => r.type !== 'POST_CONCEPT').map((r) => r.channel));
    expect([...copyChannels].sort()).toEqual(['FACEBOOK', 'INSTAGRAM']);
    expect(s.campaigns.get(res.campaignId)!.strategy.warnings).toHaveLength(1);
  });

  it('persists compliance findings on content for the reviewer', async () => {
    const risky = JSON.stringify({
      en: { headline: 'Guaranteed best oven', body: 'Now 10% off. Prices subject to change.', cta: 'Shop', hashtags: [] },
      es: { headline: 'Temporada', body: 'Con 10% de descuento. Precios sujetos a cambios.', cta: 'Compra', hashtags: [] },
    });
    const s = setup({ reply: (req) => (isStrategy(req) ? strategyReply() : risky) });
    const res = await generateCampaignStrategy(input, actor, { deps: s.deps });
    const en = [...s.contents.values()].find((r) => r.channel === 'INSTAGRAM' && r.language === 'en' && r.type !== 'POST_CONCEPT')!;
    expect(en.status).toBe('DRAFT');
    expect(en.compliance.verdict).toBe('BLOCK');
    expect(res.compliance.copy[0].compliance?.verdict).toBe('BLOCK');
  });

  it('brand-only campaign (no product) skips product safeguards', async () => {
    const s = setup();
    const res = await generateCampaignStrategy({ prompt: 'Brand awareness for fall' }, actor, { deps: s.deps });
    expect(s.checkInventory).not.toHaveBeenCalled();
    expect(s.campaigns.get(res.campaignId)!.productIds).toEqual([]);
    expect(s.adapter.requests[0].prompt).toContain('approved discount: NONE');
  });
});

// =============================================================================
describe('campaign lifecycle services', () => {
  async function seeded(opts: Parameters<typeof setup>[0] = {}) {
    const s = setup(opts);
    const res = await generateCampaignStrategy(input, actor, { deps: s.deps });
    return { ...s, id: res.campaignId };
  }

  it('SALES can submit for review; contents follow; decision is logged', async () => {
    const s = await seeded();
    const c = await transitionCampaignStatus(s.id, 'HUMAN_REVIEW', sales, {}, s.deps);
    expect(c!.status).toBe('HUMAN_REVIEW');
    expect([...s.contents.values()].every((r) => r.status === 'HUMAN_REVIEW')).toBe(true);
    expect(s.approvals).toEqual([expect.objectContaining({ fromStatus: 'DRAFT', toStatus: 'HUMAN_REVIEW', decidedById: 'u_sales', targetType: 'CAMPAIGN' })]);
  });

  it('SALES cannot approve; impossible edges are 409', async () => {
    const s = await seeded();
    await expectCampaignError(transitionCampaignStatus(s.id, 'PUBLISHED', admin, {}, s.deps), 'INVALID_STATE', 409);
    await transitionCampaignStatus(s.id, 'HUMAN_REVIEW', sales, {}, s.deps);
    await expectCampaignError(transitionCampaignStatus(s.id, 'APPROVED', sales, {}, s.deps), 'FORBIDDEN', 403);
    expect(s.campaigns.get(s.id)!.status).toBe('HUMAN_REVIEW');
  });

  it('ADMIN approval re-runs safeguards: BLOCK refuses and leaves status unchanged', async () => {
    const s = await seeded();
    await transitionCampaignStatus(s.id, 'HUMAN_REVIEW', sales, {}, s.deps);
    s.checkInventory.mockImplementation(async (id: string) => inventory(id, 'BLOCK'));
    await expectCampaignError(transitionCampaignStatus(s.id, 'APPROVED', admin, {}, s.deps), 'SAFEGUARD_BLOCKED', 422);
    expect(s.campaigns.get(s.id)!.status).toBe('HUMAN_REVIEW');
  });

  it('WARN requires acknowledgement; approval then cascades and records it', async () => {
    const s = await seeded({ margin: ['WARN'] });
    await transitionCampaignStatus(s.id, 'HUMAN_REVIEW', sales, {}, s.deps);
    await expectCampaignError(transitionCampaignStatus(s.id, 'APPROVED', admin, {}, s.deps), 'WARNINGS_NOT_ACKNOWLEDGED', 422);

    const c = await transitionCampaignStatus(s.id, 'APPROVED', admin, { acknowledgeWarnings: true, comment: 'OK' }, s.deps);
    expect(c).toMatchObject({ status: 'APPROVED', approvedById: 'u_admin' });
    expect([...s.contents.values()].every((r) => r.status === 'APPROVED' && r.reviewedById === 'u_admin')).toBe(true);
    expect(s.approvals.at(-1)).toMatchObject({ toStatus: 'APPROVED', safeguardVerdict: 'WARN', warningsAcknowledged: true });
  });

  it('blocking compliance findings on any content prevent approval', async () => {
    const risky = JSON.stringify({
      en: { headline: 'Risk-free', body: 'Now 10% off. Prices subject to change.', cta: 'Shop', hashtags: [] },
      es: { headline: 'Temporada', body: 'Con 10% de descuento. Precios sujetos a cambios.', cta: 'Compra', hashtags: [] },
    });
    const s = await seeded({ reply: (req) => (isStrategy(req) ? strategyReply() : risky) });
    await transitionCampaignStatus(s.id, 'HUMAN_REVIEW', sales, {}, s.deps);
    const err = await expectCampaignError(transitionCampaignStatus(s.id, 'APPROVED', admin, {}, s.deps), 'COMPLIANCE_BLOCKED', 422);
    expect((err.details as unknown[]).length).toBe(3); // EN copy for each of the 3 channels
  });

  it('rejection requires a comment and stores it on content', async () => {
    const s = await seeded();
    await transitionCampaignStatus(s.id, 'HUMAN_REVIEW', sales, {}, s.deps);
    await expectCampaignError(transitionCampaignStatus(s.id, 'REJECTED', admin, {}, s.deps), 'INVALID_INPUT', 400);
    await transitionCampaignStatus(s.id, 'REJECTED', admin, { comment: 'Too salesy' }, s.deps);
    expect([...s.contents.values()].every((r) => r.status === 'REJECTED' && r.rejectionReason === 'Too salesy')).toBe(true);
  });

  it('concurrent status change is detected (compare-and-set)', async () => {
    const s = await seeded();
    s.db.marketingCampaign.updateMany.mockImplementationOnce(async () => ({ count: 0 }));
    await expectCampaignError(transitionCampaignStatus(s.id, 'HUMAN_REVIEW', sales, {}, s.deps), 'CONFLICT', 409);
    expect(s.approvals).toHaveLength(0);
  });

  it('editing an APPROVED campaign reverts it to DRAFT and clears approval', async () => {
    const s = await seeded();
    await transitionCampaignStatus(s.id, 'HUMAN_REVIEW', sales, {}, s.deps);
    await transitionCampaignStatus(s.id, 'APPROVED', admin, {}, s.deps);
    const c = await updateCampaignDetails(s.id, { name: 'Fall Pizza Season v2' }, sales, s.deps);
    expect(c).toMatchObject({ name: 'Fall Pizza Season v2', status: 'DRAFT', approvedById: null });
    expect([...s.contents.values()].every((r) => r.status === 'DRAFT')).toBe(true);
    expect(s.approvals.at(-1)).toMatchObject({ fromStatus: 'APPROVED', toStatus: 'DRAFT', comment: 'Edited — approval cleared' });
  });

  it('changing discount re-runs safeguards and refuses a BLOCK', async () => {
    const s = await seeded();
    s.checkMargin.mockImplementation(async (id: string, pct: number) => margin(id, pct > 30 ? 'BLOCK' : 'PASS', pct));
    await expectCampaignError(updateCampaignDetails(s.id, { discountPct: 40 }, sales, s.deps), 'SAFEGUARD_BLOCKED', 422);
    expect(s.campaigns.get(s.id)!.discountPct).toBe(10);
    await updateCampaignDetails(s.id, { discountPct: 20 }, sales, s.deps);
    expect(s.campaigns.get(s.id)!.safeguardSnapshot.discountPct).toBe(20);
  });

  it('scheduled/published campaigns are locked; invalid patches rejected', async () => {
    const s = await seeded();
    s.campaigns.get(s.id)!.status = 'SCHEDULED';
    await expectCampaignError(updateCampaignDetails(s.id, { name: 'x' }, sales, s.deps), 'INVALID_STATE', 409);
    s.campaigns.get(s.id)!.status = 'DRAFT';
    await expectCampaignError(updateCampaignDetails(s.id, { status: 'APPROVED' }, sales, s.deps), 'INVALID_INPUT', 400);
    await expectCampaignError(
      updateCampaignDetails(s.id, { startsAt: '2026-10-10', endsAt: '2026-10-01' }, sales, s.deps),
      'INVALID_INPUT',
      400
    );
  });

  it('content edit re-validates compliance, marks it human-authored, bumps version', async () => {
    const s = await seeded();
    await transitionCampaignStatus(s.id, 'HUMAN_REVIEW', sales, {}, s.deps);
    const row = [...s.contents.values()].find((r) => r.language === 'en' && r.type === 'CAPTION')!;
    const { content, compliance } = await updateCampaignContent(row.id, { body: 'A cheap oven deal. Prices subject to change.' }, sales, s.deps);
    expect(compliance.verdict).toBe('BLOCK');
    expect(content).toMatchObject({ status: 'DRAFT', aiGenerated: false, version: 2 });
    expect(s.campaigns.get(s.id)!.status).toBe('DRAFT');
  });

  it('get / list / delete', async () => {
    const s = await seeded();
    const got = await getCampaign(s.id, sales, s.deps);
    expect(got.contents.length).toBe(10);
    await expectCampaignError(getCampaign('missing', sales, s.deps), 'NOT_FOUND', 404);

    const list = await listCampaigns({ status: 'DRAFT', channel: 'EMAIL', search: 'pizza', pageSize: 10 }, sales, s.deps);
    expect(list).toMatchObject({ total: 1, page: 1, totalPages: 1 });
    expect((await listCampaigns({ channel: 'WHATSAPP' }, sales, s.deps)).total).toBe(0);
    await expectCampaignError(listCampaigns({ page: 0 }, sales, s.deps), 'INVALID_INPUT', 400);

    await transitionCampaignStatus(s.id, 'HUMAN_REVIEW', sales, {}, s.deps);
    await transitionCampaignStatus(s.id, 'DRAFT', sales, {}, s.deps);
    await expectCampaignError(deleteDraftCampaign(s.id, sales, s.deps), 'INVALID_STATE', 409); // has history

    const fresh = await generateCampaignStrategy(input, actor, { deps: s.deps });
    await deleteDraftCampaign(fresh.campaignId, sales, s.deps);
    expect(s.campaigns.has(fresh.campaignId)).toBe(false);
  });

  it('unknown roles are refused', async () => {
    const s = await seeded();
    await expectCampaignError(getCampaign(s.id, { userId: 'x', role: 'GUEST' }, s.deps), 'FORBIDDEN', 403);
  });
});

// =============================================================================
describe('isolation', () => {
  it('campaign code writes only marketing tables', () => {
    const dir = path.resolve(__dirname, '../src/marketing/campaigns');
    for (const file of fs.readdirSync(dir)) {
      const src = fs.readFileSync(path.join(dir, file), 'utf8');
      const writes = [...src.matchAll(/\.(\w+)\.(create|createMany|update|updateMany|upsert|delete|deleteMany)\(/g)].map((m) => m[1]);
      expect(
        writes.every((m) => m.startsWith('marketing') || m === 'campaignApproval'),
        `${file}: ${writes}`
      ).toBe(true);
    }
  });
});
