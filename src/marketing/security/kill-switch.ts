/** MARKETING_ENABLED must be exactly "true" for ANY marketing side effect —
 * routes (guard.ts), the dispatcher tick, and inbound n8n callbacks. */
export function isMarketingEnabled(): boolean {
  return process.env.MARKETING_ENABLED === 'true';
}
