import crypto from 'crypto';
import { Prisma, type MarketingAiCallStatus, type MarketingSafeguardVerdict } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { redactText } from '@/marketing/security/redaction';

/**
 * Marketing AI audit trail → MarketingAiLog only (never core AiGenerationLog
 * or AuditLog). One row per pipeline call, success or failure.
 *
 * Privacy: the prompt is stored only as a SHA-256 hash (of the already
 * redacted text), model output is never stored, and error messages are
 * truncated and passed through the redactor.
 *
 * Best-effort, like src/lib/ai/audit.ts: a failed audit write is logged to
 * the console and never breaks the AI call it describes.
 */

export interface MarketingAiAuditEntry {
  templateKey: string;
  templateVersion: number;
  status: MarketingAiCallStatus;
  provider: string | null;
  model: string | null;
  attempts: number;
  fallbackUsed: boolean;
  latencyMs: number;
  inputTokens: number | null;
  outputTokens: number | null;
  requestId: string | null;
  promptHash: string;
  redactions: Record<string, number> | null;
  errorKind: string | null;
  errorMessage: string | null;
  complianceVerdict: MarketingSafeguardVerdict | null;
  campaignId: string | null;
  contentId: string | null;
  requestedById: string | null;
}

export interface MarketingAiAuditSink {
  /** Returns the log id, or null if the write failed. Never throws. */
  record(entry: MarketingAiAuditEntry): Promise<string | null>;
}

export function hashPrompt(system: string, prompt: string): string {
  return crypto.createHash('sha256').update(system).update('\u0000').update(prompt).digest('hex');
}

export function sanitizeErrorMessage(message: string | null | undefined): string | null {
  if (!message) return null;
  return redactText(message).slice(0, 500);
}

export const prismaMarketingAiAuditSink: MarketingAiAuditSink = {
  async record(entry) {
    try {
      const row = await prisma.marketingAiLog.create({
        data: {
          ...entry,
          errorMessage: sanitizeErrorMessage(entry.errorMessage),
          redactions: entry.redactions ?? Prisma.JsonNull,
        },
        select: { id: true },
      });
      return row.id;
    } catch (err) {
      console.error('[marketing-ai] failed to write MarketingAiLog row:', err);
      return null;
    }
  },
};
