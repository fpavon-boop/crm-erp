import type { AiFeature } from '@prisma/client';
import { generateCompletion, aiModelName, type AiCompletionRequest } from '@/lib/ai/client';
import { AI_SYSTEM_PROMPT, buildSummaryPrompt, parseSummaryResponse, buildDraftPrompt, parseDraftResponse } from '@/lib/ai/prompts';
import { logAiGeneration } from '@/lib/ai/audit';
import type { AiFeatureResult, AiDraftResult } from '@/lib/ai/types';

type Generate = (req: AiCompletionRequest) => Promise<string>;

interface RunAiFeatureBase {
  feature: AiFeature;
  entityType?: string | null;
  entityId?: string | null;
  companyId?: string | null;
  requestedById: string | null;
  facts: string[];
  /** DI seam for tests — same pattern as sendCommunication's `deps.emailSender`
   * (src/lib/communications/send.ts): injecting a stub avoids a real network
   * call/API key in tests while exercising the exact same audit-logging and
   * fallback-degradation code path. */
  generate?: Generate;
}

export interface RunAiSummaryFeatureOptions extends RunAiFeatureBase {
  featureLabel: string;
  instructions: string;
}

/**
 * The centralized AI service layer (docs/AI_FEATURES.md "Architecture")
 * for the six "analysis" features. Always returns `facts` verbatim from
 * the caller (never touched by the LLM). On success, `summary`/
 * `recommendations` come from the model's parsed JSON response. On any
 * failure — no API key configured, a network/API error, or (defensively)
 * an unexpected throw — the failure is logged (never swallowed) and a
 * clear `aiAvailable: false` result is returned instead of a fabricated
 * summary, so the facts remain trustworthy and visible even when the AI
 * layer itself is down.
 */
export async function runAiSummaryFeature(opts: RunAiSummaryFeatureOptions): Promise<AiFeatureResult> {
  const generatedAt = new Date().toISOString();
  const generate = opts.generate ?? generateCompletion;
  const model = aiModelName();

  try {
    const raw = await generate({ system: AI_SYSTEM_PROMPT, prompt: buildSummaryPrompt(opts.featureLabel, opts.facts, opts.instructions) });
    const parsed = parseSummaryResponse(raw);
    await logAiGeneration({
      feature: opts.feature,
      entityType: opts.entityType,
      entityId: opts.entityId,
      companyId: opts.companyId,
      requestedById: opts.requestedById,
      model,
      status: 'SUCCESS',
    });
    return { facts: opts.facts, summary: parsed.summary, recommendations: parsed.recommendations, aiAvailable: true, model, generatedAt };
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    await logAiGeneration({
      feature: opts.feature,
      entityType: opts.entityType,
      entityId: opts.entityId,
      companyId: opts.companyId,
      requestedById: opts.requestedById,
      model,
      status: 'FAILED',
      errorMessage,
    });
    return {
      facts: opts.facts,
      summary: `AI summary is unavailable right now (${errorMessage}). The facts above are still accurate — review them directly.`,
      recommendations: [],
      aiAvailable: false,
      model: null,
      generatedAt,
    };
  }
}

export interface RunAiDraftFeatureOptions extends RunAiFeatureBase {
  intentLabel: string;
  instructions: string;
}

/**
 * The centralized AI service layer for the Email Draft Assistant. Same
 * grounding/audit/degradation discipline as runAiSummaryFeature(), but
 * returns editable subject/body draft content instead of a summary +
 * recommendations — see docs/AI_FEATURES.md "Email Draft Assistant".
 */
export async function runAiDraftFeature(opts: RunAiDraftFeatureOptions): Promise<AiDraftResult> {
  const generatedAt = new Date().toISOString();
  const generate = opts.generate ?? generateCompletion;
  const model = aiModelName();

  try {
    const raw = await generate({ system: AI_SYSTEM_PROMPT, prompt: buildDraftPrompt(opts.intentLabel, opts.facts, opts.instructions) });
    const parsed = parseDraftResponse(raw);
    await logAiGeneration({
      feature: opts.feature,
      entityType: opts.entityType,
      entityId: opts.entityId,
      companyId: opts.companyId,
      requestedById: opts.requestedById,
      model,
      status: 'SUCCESS',
    });
    return { facts: opts.facts, subject: parsed.subject, body: parsed.body, aiAvailable: true, model, generatedAt };
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    await logAiGeneration({
      feature: opts.feature,
      entityType: opts.entityType,
      entityId: opts.entityId,
      companyId: opts.companyId,
      requestedById: opts.requestedById,
      model,
      status: 'FAILED',
      errorMessage,
    });
    return {
      facts: opts.facts,
      subject: '',
      body: `AI draft is unavailable right now (${errorMessage}). Write this message manually using the facts above.`,
      aiAvailable: false,
      model: null,
      generatedAt,
    };
  }
}
