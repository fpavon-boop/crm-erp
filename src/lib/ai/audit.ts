import { prisma } from '@/lib/prisma';
import type { AiFeature } from '@prisma/client';

export interface LogAiGenerationInput {
  feature: AiFeature;
  entityType?: string | null;
  entityId?: string | null;
  requestedById: string | null;
  companyId?: string | null;
  model: string | null;
  status: 'SUCCESS' | 'FAILED';
  errorMessage?: string | null;
}

/**
 * Persists one row per AI generation attempt — timestamp, requestedBy
 * userId, feature, and context entity ID, per docs/AI_FEATURES.md
 * "Audit logging". Called from src/lib/ai/service.ts for every call,
 * success or failure, never skipped.
 *
 * The write itself is best-effort (caught and logged to console rather
 * than thrown): a failure to record the audit row must not take down an
 * otherwise-successful AI response, the same "secondary bookkeeping can
 * degrade gracefully" precedent as recordIdempotentResult()
 * (src/lib/automations/idempotency.ts).
 */
export async function logAiGeneration(input: LogAiGenerationInput): Promise<void> {
  try {
    await prisma.aiGenerationLog.create({
      data: {
        feature: input.feature,
        entityType: input.entityType ?? null,
        entityId: input.entityId ?? null,
        requestedById: input.requestedById,
        companyId: input.companyId ?? null,
        model: input.model,
        status: input.status,
        errorMessage: input.errorMessage ?? null,
      },
    });
  } catch (err) {
    console.error('[ai] failed to write AiGenerationLog row:', err);
  }
}
