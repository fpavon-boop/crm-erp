import type { MarketingAiCallStatus } from '@prisma/client';
import { Redactor } from '@/marketing/security/redaction';
import type { BrandContext } from '@/marketing/content/brand-profile';
import { AnthropicAdapter } from './anthropic-adapter';
import { hashPrompt, prismaMarketingAiAuditSink, type MarketingAiAuditSink } from './audit';
import type { ComplianceReview, MarketingPromptTemplate } from './prompt-templates';
import {
  AllProvidersFailedError,
  OutputValidationError,
  ProviderError,
  ResilientAIProvider,
  type AIProviderAdapter,
  type AttemptRecord,
} from './provider';

/**
 * The one entry point for marketing AI generation:
 *
 *   input ─zod─▶ template.build (brand context + redacted brief)
 *         ─▶ ResilientAIProvider.generateJSON (retry / timeout / breaker /
 *            fallback; output MUST pass template.outputSchema)
 *         ─▶ template.review (terminology & compliance findings)
 *         ─▶ MarketingAiLog (always, success or failure)
 *
 * Output is a suggestion: callers persist it with status AI_GENERATED and it
 * must go through HUMAN_REVIEW → APPROVED (ADMIN) before anything is
 * scheduled or published (src/marketing/security/rbac.ts).
 */

export interface MarketingAiContext {
  brand: BrandContext;
  requestedById?: string | null;
  campaignId?: string | null;
  contentId?: string | null;
  provider?: ResilientAIProvider;
  audit?: MarketingAiAuditSink;
  signal?: AbortSignal;
  now?: () => number;
}

export interface MarketingAiResult<O> {
  data: O;
  compliance: ComplianceReview | null;
  /** Status the caller must persist the output with. */
  status: 'AI_GENERATED';
  meta: {
    templateKey: string;
    templateVersion: number;
    provider: string;
    model: string;
    fallbackUsed: boolean;
    attempts: AttemptRecord[];
    latencyMs: number;
    usage: { inputTokens: number; outputTokens: number } | null;
    logId: string | null;
  };
}

export class MarketingAiError extends Error {
  readonly kind: string;
  readonly attempts: AttemptRecord[];
  readonly logId: string | null;
  constructor(message: string, kind: string, attempts: AttemptRecord[], logId: string | null) {
    super(message);
    this.name = 'MarketingAiError';
    this.kind = kind;
    this.attempts = attempts;
    this.logId = logId;
  }
}

// -----------------------------------------------------------------------------
// Default provider chain (process-wide so circuit breakers persist)
// -----------------------------------------------------------------------------

/**
 * Primary: Anthropic, MARKETING_AI_MODEL (default claude-opus-5).
 * Fallback: only if MARKETING_AI_FALLBACK_MODEL is set — no silent model
 * downgrade unless configured.
 */
export function createDefaultMarketingProvider(): ResilientAIProvider {
  const adapters: AIProviderAdapter[] = [new AnthropicAdapter()];
  const fallbackModel = process.env.MARKETING_AI_FALLBACK_MODEL;
  if (fallbackModel) adapters.push(new AnthropicAdapter({ model: fallbackModel }));
  return new ResilientAIProvider(adapters, {
    timeoutMs: Number(process.env.MARKETING_AI_TIMEOUT_MS) || 90_000,
  });
}

const globalState = globalThis as unknown as { __marketingAiProvider?: ResilientAIProvider };

export function getMarketingProvider(): ResilientAIProvider {
  globalState.__marketingAiProvider ??= createDefaultMarketingProvider();
  return globalState.__marketingAiProvider;
}

// -----------------------------------------------------------------------------

function failureKind(err: unknown): { kind: string; status: MarketingAiCallStatus } {
  const last = err instanceof AllProvidersFailedError ? err.lastError : err;
  if (last instanceof OutputValidationError) return { kind: 'VALIDATION', status: 'VALIDATION_FAILED' };
  if (last instanceof ProviderError) return { kind: last.kind, status: 'FAILED' };
  return { kind: 'UNKNOWN', status: 'FAILED' };
}

/** Throws ZodError (before any model call or log) if `input` is invalid. */
export async function runMarketingPrompt<I, O>(
  template: MarketingPromptTemplate<I, O>,
  input: unknown,
  ctx: MarketingAiContext
): Promise<MarketingAiResult<O>> {
  const parsedInput = template.inputSchema.parse(input);
  const redactor = new Redactor();
  const request = template.build(parsedInput, ctx.brand, redactor);
  const provider = ctx.provider ?? getMarketingProvider();
  const audit = ctx.audit ?? prismaMarketingAiAuditSink;
  const now = ctx.now ?? Date.now;
  const started = now();

  const baseLog = {
    templateKey: template.key,
    templateVersion: template.version,
    promptHash: hashPrompt(request.system, request.prompt),
    redactions: Object.keys(redactor.summary()).length ? redactor.summary() : null,
    campaignId: ctx.campaignId ?? null,
    contentId: ctx.contentId ?? null,
    requestedById: ctx.requestedById ?? null,
  };

  try {
    const outputSchema = template.outputSchemaFor ? template.outputSchemaFor(parsedInput) : template.outputSchema;
    const res = await provider.generateJSON({ ...request, signal: ctx.signal }, outputSchema);
    const compliance = template.review ? template.review(res.data, ctx.brand, parsedInput) : null;
    const latencyMs = now() - started;
    const logId = await audit.record({
      ...baseLog,
      status: 'SUCCESS',
      provider: res.provider,
      model: res.model,
      attempts: res.attempts.length,
      fallbackUsed: res.fallbackUsed,
      latencyMs,
      inputTokens: res.usage?.inputTokens ?? null,
      outputTokens: res.usage?.outputTokens ?? null,
      requestId: res.requestId,
      errorKind: null,
      errorMessage: null,
      complianceVerdict: compliance?.verdict ?? null,
    });
    return {
      data: res.data,
      compliance,
      status: 'AI_GENERATED',
      meta: {
        templateKey: template.key,
        templateVersion: template.version,
        provider: res.provider,
        model: res.model,
        fallbackUsed: res.fallbackUsed,
        attempts: res.attempts,
        latencyMs,
        usage: res.usage,
        logId,
      },
    };
  } catch (err) {
    const attempts = err instanceof AllProvidersFailedError ? err.attempts : [];
    const { kind, status } = failureKind(err);
    const last = attempts[attempts.length - 1];
    const logId = await audit.record({
      ...baseLog,
      status,
      provider: last?.provider ?? null,
      model: last?.model ?? null,
      attempts: attempts.length,
      fallbackUsed: new Set(attempts.map((a) => `${a.provider}/${a.model}`)).size > 1,
      latencyMs: now() - started,
      inputTokens: null,
      outputTokens: null,
      requestId: null,
      errorKind: kind,
      errorMessage: err instanceof Error ? err.message : String(err),
      complianceVerdict: null,
    });
    throw new MarketingAiError(
      `Marketing AI generation failed (${template.key}): ${err instanceof Error ? err.message : String(err)}`,
      kind,
      attempts,
      logId
    );
  }
}
