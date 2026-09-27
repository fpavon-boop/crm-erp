import { z, ZodError } from 'zod';
import type { MarketingTemplate, Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { toNumber } from '@/lib/format';
import { DEFAULT_PAGE_SIZE, pageWindow, totalPages } from '@/lib/pagination';
import { canPerform } from '@/marketing/security/rbac';
import { marketingErrors } from '@/marketing/errors';
import { PLACEHOLDER_CATALOG, parsePlaceholders, placeholderDeclarationSchema, type PlaceholderDeclaration } from './placeholders';

/**
 * MarketingTemplate registry for social channels (Instagram, Facebook,
 * TikTok).
 *
 * Two validation levels:
 * 1. Structural (on save — invalid templates are rejected): parseable body,
 *    only known or declared-custom placeholders, external templates carry
 *    their provider id, internal ones carry a body.
 * 2. Readiness (before assignment to a content workflow): the template has
 *    every placeholder its kind requires, is active, targets the right
 *    channel/brand, and only uses discount placeholders on campaigns with an
 *    approved discount. A structurally valid template may be saved while not
 *    yet ready (e.g. a draft missing its CTA slot).
 *
 * Create / update / deactivate are ADMIN-only (`manage_brand`): templates are
 * shared brand assets. Everyone with marketing access can view them.
 */

export const TEMPLATE_CHANNELS = ['INSTAGRAM', 'FACEBOOK', 'TIKTOK'] as const;
type TemplateChannel = (typeof TEMPLATE_CHANNELS)[number];
type TemplateKind = 'SOCIAL_POST' | 'VIDEO' | 'DESIGN';

/** Placeholders a template must expose before it can drive generation. */
export const REQUIRED_PLACEHOLDERS: Record<TemplateKind, string[]> = {
  SOCIAL_POST: ['product_name', 'cta_text'],
  DESIGN: ['product_name', 'product_image', 'cta_text'],
  VIDEO: ['product_name', 'cta_text'],
};

type TemplateDb = Pick<typeof prisma, 'marketingTemplate' | 'marketingCampaign'>;
export interface TemplateDeps {
  db: TemplateDb;
}
export const defaultTemplateDeps: TemplateDeps = { db: prisma };

export interface Actor {
  userId: string;
  role: string;
}

function requireRole(actor: Actor, action: 'view' | 'manage_brand') {
  if (!canPerform(actor.role, action)) throw marketingErrors.forbidden(`Role ${actor.role} cannot ${action.replace('_', ' ')} templates`);
}

function parse<T>(schema: z.ZodType<T, any, unknown>, value: unknown): T {
  try {
    return schema.parse(value);
  } catch (err) {
    if (err instanceof ZodError) throw marketingErrors.invalidInput('Invalid template input', err.flatten());
    throw err;
  }
}

export const templateInputSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    description: z.string().trim().max(500).optional(),
    kind: z.enum(['SOCIAL_POST', 'VIDEO', 'DESIGN']),
    provider: z.enum(['INTERNAL', 'CANVA', 'CAPCUT']).default('INTERNAL'),
    channel: z.enum(TEMPLATE_CHANNELS),
    externalTemplateId: z.string().trim().min(1).max(200).optional(),
    body: z.string().max(10_000).optional(),
    variables: z.array(placeholderDeclarationSchema).max(50).default([]),
    brandProfileId: z.string().trim().min(1).optional(),
  })
  .strict();

export type TemplateInput = z.input<typeof templateInputSchema>;

export interface TemplateIssue {
  code:
    | 'BODY_REQUIRED'
    | 'EXTERNAL_ID_REQUIRED'
    | 'INVALID_NAME'
    | 'UNBALANCED_BRACES'
    | 'UNKNOWN_PLACEHOLDER'
    | 'CUSTOM_SHADOWS_BUILTIN'
    | 'DUPLICATE_DECLARATION'
    | 'UNUSED_DECLARATION'
    | 'MISSING_REQUIRED_PLACEHOLDER'
    | 'DISCOUNT_NOT_APPROVED'
    | 'CHANNEL_MISMATCH'
    | 'BRAND_MISMATCH'
    | 'INACTIVE';
  severity: 'ERROR' | 'WARN';
  message: string;
}

export interface TemplateAnalysis {
  placeholders: string[];
  structural: TemplateIssue[];
  /** Missing required placeholders — the template is saveable but not ready. */
  readiness: TemplateIssue[];
  ready: boolean;
}

/** Pure: structural + readiness analysis of a template definition. */
export function analyzeTemplate(t: z.output<typeof templateInputSchema>): TemplateAnalysis {
  const structural: TemplateIssue[] = [];
  const isExternal = t.provider !== 'INTERNAL';

  if (isExternal && !t.externalTemplateId) {
    structural.push({ code: 'EXTERNAL_ID_REQUIRED', severity: 'ERROR', message: `${t.provider} templates need externalTemplateId` });
  }
  if (!isExternal && !t.body?.trim()) {
    structural.push({ code: 'BODY_REQUIRED', severity: 'ERROR', message: 'Internal templates need a body' });
  }

  const seen = new Set<string>();
  for (const d of t.variables) {
    if (seen.has(d.key)) structural.push({ code: 'DUPLICATE_DECLARATION', severity: 'ERROR', message: `"${d.key}" is declared twice` });
    seen.add(d.key);
    if (d.custom && PLACEHOLDER_CATALOG[d.key]) {
      structural.push({ code: 'CUSTOM_SHADOWS_BUILTIN', severity: 'ERROR', message: `Custom "${d.key}" shadows a built-in placeholder` });
    }
    if (!d.custom && !PLACEHOLDER_CATALOG[d.key]) {
      structural.push({ code: 'UNKNOWN_PLACEHOLDER', severity: 'ERROR', message: `"${d.key}" is not built in; mark it custom: true` });
    }
  }

  let placeholders: string[];
  if (isExternal) {
    // Canva/CapCut: the declarations ARE the template's fillable fields.
    placeholders = t.variables.map((d) => d.key);
  } else {
    const parsed = parsePlaceholders(t.body ?? '');
    for (const e of parsed.errors) structural.push({ code: e.code, severity: 'ERROR', message: e.message });
    placeholders = parsed.placeholders;
    const declared = new Map(t.variables.map((d) => [d.key, d]));
    for (const p of placeholders) {
      if (!PLACEHOLDER_CATALOG[p] && !declared.get(p)?.custom) {
        structural.push({ code: 'UNKNOWN_PLACEHOLDER', severity: 'ERROR', message: `{{${p}}} is not a built-in placeholder and is not declared custom` });
      }
    }
    for (const d of t.variables) {
      if (!placeholders.includes(d.key)) {
        structural.push({ code: 'UNUSED_DECLARATION', severity: 'WARN', message: `"${d.key}" is declared but not used in the body` });
      }
    }
  }

  const readiness: TemplateIssue[] = REQUIRED_PLACEHOLDERS[t.kind]
    .filter((r) => !placeholders.includes(r))
    .map((r) => ({ code: 'MISSING_REQUIRED_PLACEHOLDER' as const, severity: 'ERROR' as const, message: `${t.kind} templates need {{${r}}}` }));

  const hasErrors = [...structural, ...readiness].some((i) => i.severity === 'ERROR');
  return { placeholders, structural, readiness, ready: !hasErrors };
}

function assertStructurallyValid(analysis: TemplateAnalysis) {
  const errors = analysis.structural.filter((i) => i.severity === 'ERROR');
  if (errors.length) throw marketingErrors.unprocessable('TEMPLATE_INVALID', errors.map((e) => e.message).join('; '), errors);
}

async function assertNoExternalDuplicate(t: z.output<typeof templateInputSchema>, deps: TemplateDeps, exceptId?: string) {
  if (!t.externalTemplateId) return;
  const dup = await deps.db.marketingTemplate.findFirst({
    where: { provider: t.provider, externalTemplateId: t.externalTemplateId, ...(exceptId ? { id: { not: exceptId } } : {}) },
    select: { id: true },
  });
  if (dup) throw marketingErrors.duplicate(`${t.provider} template ${t.externalTemplateId} is already registered`, { existingId: dup.id });
}

function toData(t: z.output<typeof templateInputSchema>, analysis: TemplateAnalysis) {
  return {
    name: t.name,
    description: t.description ?? null,
    kind: t.kind,
    provider: t.provider,
    channel: t.channel,
    externalTemplateId: t.externalTemplateId ?? null,
    body: t.body ?? null,
    variables: t.variables as unknown as Prisma.InputJsonValue,
    placeholders: analysis.placeholders,
    brandProfileId: t.brandProfileId ?? null,
  };
}

// =============================================================================
// CRUD
// =============================================================================

export async function createTemplate(input: unknown, actor: Actor, deps: TemplateDeps = defaultTemplateDeps) {
  requireRole(actor, 'manage_brand');
  const t = parse(templateInputSchema, input);
  const analysis = analyzeTemplate(t);
  assertStructurallyValid(analysis);
  await assertNoExternalDuplicate(t, deps);
  const template = await deps.db.marketingTemplate.create({ data: { ...toData(t, analysis), active: true, createdById: actor.userId } });
  return { template, analysis };
}

/** Full replacement of the definition (re-validated). */
export async function updateTemplate(id: string, input: unknown, actor: Actor, deps: TemplateDeps = defaultTemplateDeps) {
  requireRole(actor, 'manage_brand');
  const existing = await deps.db.marketingTemplate.findUnique({ where: { id } });
  if (!existing) throw marketingErrors.notFound('Template', id);
  const t = parse(templateInputSchema, input);
  const analysis = analyzeTemplate(t);
  assertStructurallyValid(analysis);
  await assertNoExternalDuplicate(t, deps, id);
  const template = await deps.db.marketingTemplate.update({ where: { id }, data: toData(t, analysis) });
  return { template, analysis };
}

export async function setTemplateActive(id: string, active: boolean, actor: Actor, deps: TemplateDeps = defaultTemplateDeps) {
  requireRole(actor, 'manage_brand');
  const existing = await deps.db.marketingTemplate.findUnique({ where: { id } });
  if (!existing) throw marketingErrors.notFound('Template', id);
  return deps.db.marketingTemplate.update({ where: { id }, data: { active } });
}

export async function getTemplate(id: string, actor: Actor, deps: TemplateDeps = defaultTemplateDeps) {
  requireRole(actor, 'view');
  const template = await deps.db.marketingTemplate.findUnique({ where: { id } });
  if (!template) throw marketingErrors.notFound('Template', id);
  return { template, analysis: analyzeStored(template) };
}

const listSchema = z
  .object({
    channel: z.enum(TEMPLATE_CHANNELS).optional(),
    kind: z.enum(['SOCIAL_POST', 'VIDEO', 'DESIGN']).optional(),
    provider: z.enum(['INTERNAL', 'CANVA', 'CAPCUT']).optional(),
    includeInactive: z.boolean().default(false),
    page: z.number().int().min(1).default(1),
    pageSize: z.number().int().min(1).max(100).default(DEFAULT_PAGE_SIZE),
  })
  .strict();

export async function listTemplates(query: z.input<typeof listSchema>, actor: Actor, deps: TemplateDeps = defaultTemplateDeps) {
  requireRole(actor, 'view');
  const q = parse(listSchema, query);
  const where: Prisma.MarketingTemplateWhereInput = {
    ...(q.channel ? { channel: q.channel } : {}),
    ...(q.kind ? { kind: q.kind } : {}),
    ...(q.provider ? { provider: q.provider } : {}),
    ...(q.includeInactive ? {} : { active: true }),
  };
  const [items, total] = await Promise.all([
    deps.db.marketingTemplate.findMany({ where, orderBy: { name: 'asc' }, ...pageWindow(q.page, q.pageSize) }),
    deps.db.marketingTemplate.count({ where }),
  ]);
  return { items, total, page: q.page, pageSize: q.pageSize, totalPages: totalPages(total, q.pageSize) };
}

// =============================================================================
// Assignment readiness
// =============================================================================

function analyzeStored(t: MarketingTemplate): TemplateAnalysis {
  const parsed = templateInputSchema.safeParse({
    name: t.name,
    description: t.description ?? undefined,
    kind: t.kind,
    provider: t.provider,
    channel: t.channel,
    externalTemplateId: t.externalTemplateId ?? undefined,
    body: t.body ?? undefined,
    variables: (t.variables as PlaceholderDeclaration[] | null) ?? [],
    brandProfileId: t.brandProfileId ?? undefined,
  });
  if (!parsed.success) {
    return {
      placeholders: t.placeholders,
      structural: [{ code: 'UNKNOWN_PLACEHOLDER', severity: 'ERROR', message: `Stored template no longer validates: ${parsed.error.issues[0]?.message}` }],
      readiness: [],
      ready: false,
    };
  }
  return analyzeTemplate(parsed.data);
}

/**
 * Throws TEMPLATE_NOT_READY (422) with every reason unless the template can
 * drive content generation for `channel` (and, if given, `campaignId`).
 * Read-only.
 */
export async function assertTemplateAssignable(
  templateId: string,
  target: { channel: string; campaignId?: string },
  actor: Actor,
  deps: TemplateDeps = defaultTemplateDeps
) {
  requireRole(actor, 'view');
  const template = await deps.db.marketingTemplate.findUnique({ where: { id: templateId } });
  if (!template) throw marketingErrors.notFound('Template', templateId);

  const analysis = analyzeStored(template);
  const issues: TemplateIssue[] = [...analysis.structural, ...analysis.readiness].filter((i) => i.severity === 'ERROR');

  if (!template.active) issues.push({ code: 'INACTIVE', severity: 'ERROR', message: 'Template is inactive' });
  if (template.channel !== (target.channel as TemplateChannel)) {
    issues.push({ code: 'CHANNEL_MISMATCH', severity: 'ERROR', message: `Template is for ${template.channel}, not ${target.channel}` });
  }

  if (target.campaignId) {
    const campaign = await deps.db.marketingCampaign.findUnique({
      where: { id: target.campaignId },
      select: { id: true, discountPct: true, brandProfileId: true, channels: true },
    });
    if (!campaign) throw marketingErrors.notFound('Campaign', target.campaignId);
    const hasDiscount = campaign.discountPct != null && toNumber(campaign.discountPct) > 0;
    const discountSlots = analysis.placeholders.filter((p) => PLACEHOLDER_CATALOG[p]?.requiresDiscount);
    if (discountSlots.length && !hasDiscount) {
      issues.push({
        code: 'DISCOUNT_NOT_APPROVED',
        severity: 'ERROR',
        message: `Template uses ${discountSlots.map((p) => `{{${p}}}`).join(', ')} but the campaign has no approved discount`,
      });
    }
    if (template.brandProfileId && campaign.brandProfileId && template.brandProfileId !== campaign.brandProfileId) {
      issues.push({ code: 'BRAND_MISMATCH', severity: 'ERROR', message: 'Template belongs to a different brand profile than the campaign' });
    }
  }

  if (issues.length) throw marketingErrors.unprocessable('TEMPLATE_NOT_READY', issues.map((i) => i.message).join('; '), issues);
  return { template, placeholders: analysis.placeholders };
}
