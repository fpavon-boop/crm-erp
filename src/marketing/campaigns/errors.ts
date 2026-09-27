import type { SafeguardEvaluation } from './safeguard-gate';

/** Typed campaign errors; `httpStatus` lets API routes map them directly. */
export class CampaignError extends Error {
  readonly code: string;
  readonly httpStatus: number;
  readonly details?: unknown;
  constructor(code: string, message: string, httpStatus: number, details?: unknown) {
    super(message);
    this.name = 'CampaignError';
    this.code = code;
    this.httpStatus = httpStatus;
    this.details = details;
  }
}

export class CampaignSafeguardError extends CampaignError {
  readonly evaluation: SafeguardEvaluation;
  constructor(evaluation: SafeguardEvaluation, stage: string) {
    const reasons = evaluation.products
      .flatMap((p) => [...p.inventory.issues, ...p.margin.issues])
      .concat(evaluation.issues)
      .filter((i) => i.severity === 'BLOCK')
      .map((i) => i.message);
    super('SAFEGUARD_BLOCKED', `Campaign blocked by safeguards (${stage}): ${reasons.join(' | ')}`, 422, evaluation);
    this.name = 'CampaignSafeguardError';
    this.evaluation = evaluation;
  }
}

export const campaignErrors = {
  notFound: (what: string, id: string) => new CampaignError('NOT_FOUND', `${what} ${id} not found`, 404),
  forbidden: (msg: string) => new CampaignError('FORBIDDEN', msg, 403),
  invalidState: (msg: string) => new CampaignError('INVALID_STATE', msg, 409),
  conflict: (msg: string) => new CampaignError('CONFLICT', msg, 409),
  invalidInput: (msg: string, details?: unknown) => new CampaignError('INVALID_INPUT', msg, 400, details),
  brandRequired: () =>
    new CampaignError('BRAND_PROFILE_REQUIRED', 'No active default brand profile with EN and ES definitions is configured.', 412),
  warningsNotAcknowledged: (details: unknown) =>
    new CampaignError('WARNINGS_NOT_ACKNOWLEDGED', 'Safeguard warnings must be acknowledged before approval.', 422, details),
  complianceBlocked: (details: unknown) =>
    new CampaignError('COMPLIANCE_BLOCKED', 'Some content has blocking compliance issues; edit it before approval.', 422, details),
};
