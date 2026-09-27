import crypto from 'crypto';
import { z, ZodError } from 'zod';
import { Prisma, type MarketingChannel, type MarketingContentType } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { toNumber } from '@/lib/format';
import { getDefaultBrandProfile, getBrandProfile, type BrandContext } from '@/marketing/content/brand-profile';
import type { BilingualCopy, ProductFact } from '@/marketing/content/localization';
import { runMarketingPrompt, MarketingAiError, type MarketingAiContext, type MarketingAiResult } from '@/marketing/ai/pipeline';
import {
  bilingualCopyTemplate,
  campaignStrategyTemplate,
  MARKETING_CHANNELS,
  type CampaignStrategy,
  type ComplianceFinding,
  type ComplianceReview,
} from '@/marketing/ai/prompt-templates';
import { defaultSafeguardChecks, evaluateCampaignSafeguards, type SafeguardChecks, type SafeguardEvaluation } from './safeguard-gate';
import { CampaignSafeguardError, campaignErrors } from './errors';

/**
 * Campaign strategy engine.
 *
 *   input ─▶ product safeguards (Phase 4: stock + margin) ── BLOCK ─▶ throw, nothing called or saved
 *         ─▶ default brand profile (Phase 5; EN + ES required)
 *         ─▶ AI strategy (Phase 6 pipeline): objectives, segments, channel mix, concepts
 *         ─▶ AI bilingual copy for the top channels (non-fatal per channel)
 *         ─▶ safeguards re-checked (stock/cost may have moved during generation)
 *         ─▶ one transaction: MarketingCampaign + MarketingContent rows, ALL status DRAFT
 *
 * Nothing here can approve, schedule or publish; generated rows wait for
 * human review (src/marketing/campaigns/service.ts transitions, ADMIN-gated).
 *
 * Only product name/SKU/price/description go to the AI — never unit cost,
 * margin or stock figures.
 */

export const MAX_COPY_CHANNELS = 3;

const channelSchema = z
  .string()
  .trim()
  .transform((s) => s.toUpperCase())
  .pipe(z.enum(MARKETING_CHANNELS));

export const campaignStrategyInputSchema = z
  .object({
    prompt: z.string().trim().min(1).max(2000),
    productId: z.string().trim().min(1).optional(),
    budget: z.number().positive().max(10_000_000).optional(),
    targetChannels: z.array(channelSchema).min(1).max(6).optional(),
    proposedDiscountPct: z.number().min(0).max(99).optional(),
    durationDays: z.number().int().min(1).max(365).optional(),
  })
  .refine((i) => i.proposedDiscountPct == null || i.proposedDiscountPct === 0 || i.productId, {
    message: 'A discount requires a productId so margin can be verified',
    path: ['proposedDiscountPct'],
  });

export type CampaignStrategyInput = z.input<typeof campaignStrategyInputSchema>;

export interface ProductSnapshot {
  id: string;
  sku: string;
  name: string;
  description: string | null;
  category: string | null;
  price: number;
}

type CampaignDb = Pick<typeof prisma, 'marketingCampaign' | 'marketingContent' | 'campaignApproval' | '$transaction'>;

export interface CampaignEngineDeps {
  db: CampaignDb;
  safeguards: SafeguardChecks;
  loadProduct(id: string): Promise<ProductSnapshot | null>;
  getBrand(brandProfileId?: string | null): Promise<BrandContext | null>;
  runPrompt: typeof runMarketingPrompt;
  aiContext?: Partial<Pick<MarketingAiContext, 'provider' | 'audit'>>;
  newId(): string;
  now(): Date;
}

/** Read-only product lookup (the only core table read besides safeguards). */
async function loadProductReadOnly(id: string): Promise<ProductSnapshot | null> {
  const p = await prisma.product.findUnique({
    where: { id },
    select: { id: true, sku: true, name: true, description: true, category: true, price: true },
  });
  return p ? { ...p, price: toNumber(p.price) } : null;
}

export const defaultCampaignDeps: CampaignEngineDeps = {
  db: prisma,
  safeguards: defaultSafeguardChecks,
  loadProduct: loadProductReadOnly,
  getBrand: async (id) => (id ? getBrandProfile(id) : getDefaultBrandProfile()),
  runPrompt: runMarketingPrompt,
  newId: () => crypto.randomUUID(),
  now: () => new Date(),
};

export function withDeps(overrides: Partial<CampaignEngineDeps> = {}): CampaignEngineDeps {
  return { ...defaultCampaignDeps, ...overrides };
}

function contentTypeFor(channel: MarketingChannel): MarketingContentType {
  if (channel === 'EMAIL') return 'EMAIL';
  if (channel === 'WHATSAPP') return 'WHATSAPP_MESSAGE';
  if (channel === 'WEBSITE') return 'POST_COPY';
  return 'CAPTION';
}

function toProductFact(p: ProductSnapshot, promoPrice: number | null): ProductFact {
  const highlights = [p.category ? `category: ${p.category}` : null, p.description ? p.description.slice(0, 300) : null].filter(
    (h): h is string => Boolean(h)
  );
  return {
    name: p.name,
    sku: p.sku,
    listPrice: p.price > 0 ? p.price : undefined,
    promoPrice: promoPrice ?? undefined,
    highlights: highlights.length ? highlights : undefined,
  };
}

function findingsFor(review: ComplianceReview | null, prefix: string): ComplianceReview | null {
  if (!review) return null;
  const findings = review.findings.filter((f) => f.path === prefix || f.path.startsWith(`${prefix}.`));
  const issues = findings.flatMap((f) => f.issues);
  return {
    verdict: issues.some((i) => i.severity === 'BLOCK') ? 'BLOCK' : issues.length ? 'WARN' : 'PASS',
    findings,
  };
}

const json = (v: unknown) => JSON.parse(JSON.stringify(v)) as Prisma.InputJsonValue;

export interface GeneratedCopyVariant {
  channel: MarketingChannel;
  variantGroupId: string;
  compliance: ComplianceReview | null;
}

export interface CampaignStrategyResult {
  campaignId: string;
  campaign: Awaited<ReturnType<CampaignDb['marketingCampaign']['create']>>;
  strategy: CampaignStrategy;
  safeguards: SafeguardEvaluation;
  compliance: { strategy: ComplianceReview | null; copy: GeneratedCopyVariant[] };
  warnings: string[];
}

export async function generateCampaignStrategy(
  rawInput: unknown,
  actor: { userId: string },
  options: { deps?: CampaignEngineDeps; signal?: AbortSignal } = {}
): Promise<CampaignStrategyResult> {
  const deps = options.deps ?? defaultCampaignDeps;

  let input: z.output<typeof campaignStrategyInputSchema>;
  try {
    input = campaignStrategyInputSchema.parse(rawInput);
  } catch (err) {
    if (err instanceof ZodError) throw campaignErrors.invalidInput('Invalid campaign strategy input', err.flatten());
    throw err;
  }
  const productIds = input.productId ? [input.productId] : [];
  const discountPct = input.proposedDiscountPct ?? null;

  // 1. Safeguards first — a blocked product costs no AI call and writes nothing.
  const safeguards = await evaluateCampaignSafeguards(productIds, discountPct, deps.safeguards, { now: deps.now });
  if (safeguards.verdict === 'BLOCK') throw new CampaignSafeguardError(safeguards, 'pre-generation');

  const product = input.productId ? await deps.loadProduct(input.productId) : null;
  if (input.productId && !product) throw campaignErrors.notFound('Product', input.productId);

  // 2. Brand
  const brand = await deps.getBrand(null);
  if (!brand) throw campaignErrors.brandRequired();

  const aiCtx: MarketingAiContext = { brand, requestedById: actor.userId, signal: options.signal, ...deps.aiContext };
  const promoPrice = safeguards.products[0]?.margin.promoPrice ?? null;
  const productFacts = product ? [toProductFact(product, discountPct ? promoPrice : null)] : [];
  const warnings: string[] = [];

  // 3. Strategy (fatal on failure)
  const strategyRun = await deps.runPrompt(
    campaignStrategyTemplate,
    {
      prompt: input.prompt,
      product: productFacts[0],
      budgetUsd: input.budget,
      targetChannels: input.targetChannels,
      approvedDiscountPct: discountPct,
      durationDays: input.durationDays,
    },
    aiCtx
  );
  const strategy = strategyRun.data;

  // 4. Bilingual copy for the highest-weighted channels (non-fatal per channel)
  const copyChannels = [...strategy.recommendedChannels]
    .sort((a, b) => b.budgetSharePct - a.budgetSharePct)
    .slice(0, MAX_COPY_CHANNELS)
    .map((c) => c.channel);

  const copies: Array<{ channel: MarketingChannel; run: MarketingAiResult<BilingualCopy> }> = [];
  for (const channel of copyChannels) {
    try {
      const run = await deps.runPrompt(
        bilingualCopyTemplate,
        {
          objective: strategy.summary.en,
          channel,
          contentType: contentTypeFor(channel),
          productFacts,
          approvedDiscountPct: discountPct,
          keyMessages: strategy.objectives.map((o) => o.title),
          audienceNote: strategy.audienceSegments.map((s) => s.name).join('; ').slice(0, 500),
        },
        aiCtx
      );
      copies.push({ channel, run });
    } catch (err) {
      if (!(err instanceof MarketingAiError)) throw err;
      warnings.push(`Copy generation for ${channel} failed (${err.kind}); add it manually or regenerate.`);
    }
  }

  // 5. Re-check: stock or cost may have changed while the model was working.
  const finalSafeguards = await evaluateCampaignSafeguards(productIds, discountPct, deps.safeguards, { now: deps.now });
  if (finalSafeguards.verdict === 'BLOCK') throw new CampaignSafeguardError(finalSafeguards, 'pre-persist');

  // 6. Persist — everything DRAFT.
  const base = {
    status: 'DRAFT' as const,
    aiGenerated: true,
    productIds,
    createdById: actor.userId,
  };
  const contents: Prisma.MarketingContentCreateWithoutCampaignInput[] = [];
  const copyVariants: GeneratedCopyVariant[] = [];

  for (const { channel, run } of copies) {
    const variantGroupId = deps.newId();
    copyVariants.push({ channel, variantGroupId, compliance: run.compliance });
    for (const lang of ['en', 'es'] as const) {
      const v = run.data[lang];
      contents.push({
        ...base,
        channel,
        type: contentTypeFor(channel),
        language: lang,
        title: v.headline,
        body: [v.body, v.cta].filter(Boolean).join('\n\n'),
        hashtags: v.hashtags,
        aiModel: run.meta.model,
        aiLogId: run.meta.logId,
        variantGroupId,
        compliance: json(findingsFor(run.compliance, lang) ?? Prisma.JsonNull),
      });
    }
  }

  strategy.postConcepts.forEach((concept, i) => {
    const variantGroupId = deps.newId();
    for (const lang of ['en', 'es'] as const) {
      contents.push({
        ...base,
        channel: concept.channel,
        type: 'POST_CONCEPT',
        language: lang,
        title: concept.hook[lang],
        body: `[${concept.format}] ${concept.description[lang]}`,
        hashtags: [],
        aiModel: strategyRun.meta.model,
        aiLogId: strategyRun.meta.logId,
        variantGroupId,
        compliance: json(findingsFor(strategyRun.compliance, `postConcepts.${i}.${lang}`) ?? Prisma.JsonNull),
      });
    }
  });

  const strategyFindings: ComplianceFinding[] = strategyRun.compliance?.findings ?? [];
  const campaign = await deps.db.$transaction((tx) =>
    tx.marketingCampaign.create({
      data: {
        name: strategy.name,
        objective: strategy.objectives.map((o) => o.title).join('; ').slice(0, 500),
        description: strategy.summary.en,
        status: 'DRAFT',
        channels: strategy.recommendedChannels.map((c) => c.channel),
        brandProfileId: brand.id,
        productIds,
        productVariantIds: [],
        discountPct: discountPct ?? null,
        budget: input.budget ?? null,
        sourcePrompt: input.prompt,
        strategy: json({
          templateKey: campaignStrategyTemplate.key,
          templateVersion: campaignStrategyTemplate.version,
          model: strategyRun.meta.model,
          aiLogId: strategyRun.meta.logId,
          summary: strategy.summary,
          objectives: strategy.objectives,
          audienceSegments: strategy.audienceSegments,
          recommendedChannels: strategy.recommendedChannels,
          compliance: { verdict: strategyRun.compliance?.verdict ?? null, findings: strategyFindings },
          warnings,
        }),
        safeguardSnapshot: json(finalSafeguards),
        createdById: actor.userId,
        contents: { create: contents },
      },
      include: { contents: true },
    })
  );

  return {
    campaignId: campaign.id,
    campaign,
    strategy,
    safeguards: finalSafeguards,
    compliance: { strategy: strategyRun.compliance, copy: copyVariants },
    warnings,
  };
}
