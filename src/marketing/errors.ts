/** Typed error for marketing services (assets, templates, …); `httpStatus`
 * lets API routes map it directly. Campaign services use CampaignError
 * (src/marketing/campaigns/errors.ts), which has the same shape. */
export class MarketingError extends Error {
  readonly code: string;
  readonly httpStatus: number;
  readonly details?: unknown;
  constructor(code: string, message: string, httpStatus: number, details?: unknown) {
    super(message);
    this.name = 'MarketingError';
    this.code = code;
    this.httpStatus = httpStatus;
    this.details = details;
  }
}

export const marketingErrors = {
  notFound: (what: string, id: string) => new MarketingError('NOT_FOUND', `${what} ${id} not found`, 404),
  forbidden: (msg: string) => new MarketingError('FORBIDDEN', msg, 403),
  invalidInput: (msg: string, details?: unknown) => new MarketingError('INVALID_INPUT', msg, 400, details),
  invalidState: (msg: string, details?: unknown) => new MarketingError('INVALID_STATE', msg, 409, details),
  duplicate: (msg: string, details?: unknown) => new MarketingError('DUPLICATE', msg, 409, details),
  unprocessable: (code: string, msg: string, details?: unknown) => new MarketingError(code, msg, 422, details),
};
