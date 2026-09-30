import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import { canPerform } from '@/marketing/security/rbac';
import { marketingErrors } from '@/marketing/errors';
import { getBrandProfile, getDefaultBrandProfile } from '@/marketing/content/brand-profile';
import { MARKETING_PROMPT_TEMPLATES, type MarketingPromptKey } from '@/marketing/ai/prompt-templates';
import { runMarketingPrompt, type MarketingAiContext } from '@/marketing/ai/pipeline';

/**
 * On-demand AI content generation (preview). Runs one versioned template
 * through the Phase 6 pipeline with the campaign's (or default) brand and
 * returns validated output + compliance findings. Nothing is persisted here:
 * the reviewer copies what they keep into campaign content (PATCH
 * /api/marketing/content/:id), which re-runs compliance and stays DRAFT.
 */

const schema = z
  .object({
    template: z.enum(Object.keys(MARKETING_PROMPT_TEMPLATES) as [MarketingPromptKey, ...MarketingPromptKey[]]),
    input: z.record(z.unknown()),
    campaignId: z.string().trim().min(1).optional(),
  })
  .strict();

export async function generateContentPreview(
  body: unknown,
  actor: { userId: string; role: string },
  aiContext: Partial<Pick<MarketingAiContext, 'provider' | 'audit'>> = {}
) {
  if (!canPerform(actor.role, 'draft')) throw marketingErrors.forbidden(`Role ${actor.role} cannot generate content`);
  const b = schema.parse(body);
  let brandProfileId: string | null = null;
  if (b.campaignId) {
    const campaign = await prisma.marketingCampaign.findUnique({ where: { id: b.campaignId }, select: { brandProfileId: true } });
    if (!campaign) throw marketingErrors.notFound('Campaign', b.campaignId);
    brandProfileId = campaign.brandProfileId;
  }
  const brand = brandProfileId ? await getBrandProfile(brandProfileId) : await getDefaultBrandProfile();
  if (!brand) throw marketingErrors.unprocessable('BRAND_PROFILE_REQUIRED', 'No active brand profile with EN and ES definitions is configured');
  const template = MARKETING_PROMPT_TEMPLATES[b.template];
  return runMarketingPrompt(template as never, b.input, { brand, requestedById: actor.userId, campaignId: b.campaignId ?? null, ...aiContext });
}
