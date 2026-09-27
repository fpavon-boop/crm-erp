import type { MarketingSafeguardVerdict } from '@prisma/client';
import {
  checkInventoryStatus,
  checkMarginViability,
  DEFAULT_SAFEGUARD_POLICY,
  type InventoryStatus,
  type MarginViability,
  type SafeguardIssue,
  type SafeguardPolicy,
} from '@/marketing/ai/safeguards';

/**
 * Campaign-level wrapper around the Phase 4 read-only safeguards: evaluates
 * every product a campaign promotes at its proposed discount and folds the
 * results into one verdict + a JSON-safe snapshot for
 * MarketingCampaign.safeguardSnapshot / CampaignApproval.safeguardSnapshot.
 */

export interface SafeguardChecks {
  checkInventory(productId: string, policy: SafeguardPolicy): Promise<InventoryStatus>;
  checkMargin(productId: string, discountPct: number, policy: SafeguardPolicy): Promise<MarginViability>;
}

export const defaultSafeguardChecks: SafeguardChecks = {
  checkInventory: (id, policy) => checkInventoryStatus(id, policy),
  checkMargin: (id, pct, policy) => checkMarginViability(id, pct, { policy }),
};

export interface SafeguardEvaluation {
  verdict: MarketingSafeguardVerdict;
  evaluatedAt: string;
  policy: SafeguardPolicy;
  discountPct: number | null;
  products: Array<{ productId: string; inventory: InventoryStatus; margin: MarginViability }>;
  /** Campaign-level issues not tied to one product. */
  issues: SafeguardIssue[];
}

function worst(verdicts: MarketingSafeguardVerdict[]): MarketingSafeguardVerdict {
  if (verdicts.includes('BLOCK')) return 'BLOCK';
  if (verdicts.includes('WARN')) return 'WARN';
  return 'PASS';
}

export async function evaluateCampaignSafeguards(
  productIds: string[],
  discountPct: number | null,
  checks: SafeguardChecks = defaultSafeguardChecks,
  options: { policy?: SafeguardPolicy; now?: () => Date } = {}
): Promise<SafeguardEvaluation> {
  const policy = options.policy ?? DEFAULT_SAFEGUARD_POLICY;
  const issues: SafeguardIssue[] = [];
  const ids = Array.from(new Set(productIds));

  if (!ids.length && discountPct != null && discountPct > 0) {
    issues.push({
      code: 'INVALID_DISCOUNT',
      severity: 'BLOCK',
      message: 'A discount requires at least one product so margin can be verified.',
    });
  }

  const products = await Promise.all(
    ids.map(async (productId) => {
      const [inventory, margin] = await Promise.all([
        checks.checkInventory(productId, policy),
        checks.checkMargin(productId, discountPct ?? 0, policy),
      ]);
      return { productId, inventory, margin };
    })
  );

  const verdict = worst([
    ...products.flatMap((p) => [p.inventory.verdict, p.margin.verdict]),
    ...issues.map((i) => i.severity),
  ]);
  return {
    verdict,
    evaluatedAt: (options.now ?? (() => new Date()))().toISOString(),
    policy: { ...policy },
    discountPct,
    products,
    issues,
  };
}
