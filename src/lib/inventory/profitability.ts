/**
 * Pricing/margin math for the refractory inventory catalog
 * (RefractoryProduct). Pure functions, no DB — every price and margin
 * stored on a RefractoryProduct row is derived from these, never
 * hand-entered independently, so cost/freight changes have one
 * authoritative place to recompute from.
 *
 * - Landed cost = acquisitionCost + freightCost.
 * - Price(tier) = landedCost * (1 + markup / 100).
 * - True margin(tier) = ((price - landedCost) / price) * 100.
 */
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export function computeLandedCost(acquisitionCost: number, freightCost: number): number {
  return round2(acquisitionCost + freightCost);
}

export function computePrice(landedCost: number, markupPct: number): number {
  return round2(landedCost * (1 + markupPct / 100));
}

/** Never divides by zero: a price of 0 (or less) has no meaningful margin. */
export function computeTrueMargin(price: number, landedCost: number): number {
  if (price <= 0) return 0;
  return round2(((price - landedCost) / price) * 100);
}

export interface RefractoryPricingInput {
  acquisitionCost: number;
  freightCost: number;
  markupDistributor: number;
  markupContractor: number;
  markupRetail: number;
}

export interface RefractoryPricingResult {
  totalLandedCost: number;
  distributorPrice: number;
  contractorPrice: number;
  retailPrice: number;
  trueMarginDist: number;
  trueMarginCont: number;
  trueMarginRet: number;
}

/**
 * The single recalculation helper every write path (importer, PATCH route)
 * goes through whenever acquisitionCost, freightCost, or a markup changes —
 * so totalLandedCost/prices/margins can never drift out of sync with the
 * cost/freight/markup values they're derived from.
 */
export function recalculateRefractoryPricing(input: RefractoryPricingInput): RefractoryPricingResult {
  const totalLandedCost = computeLandedCost(input.acquisitionCost, input.freightCost);
  const distributorPrice = computePrice(totalLandedCost, input.markupDistributor);
  const contractorPrice = computePrice(totalLandedCost, input.markupContractor);
  const retailPrice = computePrice(totalLandedCost, input.markupRetail);

  return {
    totalLandedCost,
    distributorPrice,
    contractorPrice,
    retailPrice,
    trueMarginDist: computeTrueMargin(distributorPrice, totalLandedCost),
    trueMarginCont: computeTrueMargin(contractorPrice, totalLandedCost),
    trueMarginRet: computeTrueMargin(retailPrice, totalLandedCost),
  };
}
