/**
 * Universal pricing/profitability engine for the catalog inventory system
 * (CatalogProduct) — covers every product type sold (ovens & oven kits,
 * iron doors, refractory materials, accessories, tools, stains/enhancers,
 * and anything added later via categoryGroup=CUSTOM). Pure functions, no
 * DB — every cost, price, and margin stored on a CatalogProduct row is
 * derived from these, never hand-entered independently, so a change to
 * cost, freight, a fee rate, or a tier markup has exactly one authoritative
 * place to recompute from: recalculateProductFinancials().
 *
 * Model:
 * - totalLandedCost = (acquisitionCost + freightCost + importTaxesOrFees +
 *   packagingCost) grossed up by shrinkageLossRate% (a loss-rate markup on
 *   the cost side — e.g. 2% of units lost to breakage inflates the
 *   effective per-unit cost of the units that do sell).
 * - price(tier) = an explicit override if one is set, else
 *   totalLandedCost * (1 + markup% / 100).
 * - netProfit(tier) = price(tier) - totalLandedCost - price(tier) *
 *   paymentProcessingFeeRate% (the processor's cut comes out of the
 *   selling price, not the cost side).
 * - trueMargin(tier)% = netProfit(tier) / price(tier) * 100 — "true"
 *   because it's net of every cost and fee, not a naive markup.
 */
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export function computeLandedCost(
  acquisitionCost: number,
  freightCost: number,
  importTaxesOrFees: number = 0,
  packagingCost: number = 0,
  shrinkageLossRate: number = 0
): number {
  const directCosts = acquisitionCost + freightCost + importTaxesOrFees + packagingCost;
  return round2(directCosts * (1 + shrinkageLossRate / 100));
}

/** A fixed price override always wins over the markup calculation — this
 * is the "fixed price overrides per tier" half of the pricing-tier spec. */
export function computeTierPrice(landedCost: number, markupPct: number, override?: number | null): number {
  if (override !== undefined && override !== null) return round2(override);
  return round2(landedCost * (1 + markupPct / 100));
}

export function computeNetProfit(price: number, landedCost: number, paymentProcessingFeeRate: number): number {
  const processingFee = price * (paymentProcessingFeeRate / 100);
  return round2(price - landedCost - processingFee);
}

/** Never divides by zero: a price of 0 (or less) has no meaningful margin. */
export function computeTrueMarginPct(netProfit: number, price: number): number {
  if (price <= 0) return 0;
  return round2((netProfit / price) * 100);
}

export interface ProductFinancialsInput {
  acquisitionCost: number;
  freightCost: number;
  importTaxesOrFees: number;
  packagingCost: number;
  shrinkageLossRate: number;
  paymentProcessingFeeRate: number;
  markupDistributor: number;
  markupContractor: number;
  markupRetail: number;
  distributorPriceOverride?: number | null;
  contractorPriceOverride?: number | null;
  retailPriceOverride?: number | null;
}

export interface ProductFinancialsResult {
  totalLandedCost: number;
  distributorPrice: number;
  contractorPrice: number;
  retailPrice: number;
  netProfitDist: number;
  netProfitCont: number;
  netProfitRet: number;
  trueMarginDist: number;
  trueMarginCont: number;
  trueMarginRet: number;
}

/**
 * The single recalculation helper every write path (importer, PATCH route)
 * goes through whenever any cost, fee rate, markup, or price override
 * changes. Category-agnostic and product-type-agnostic: the same math
 * applies to a $15 door handle and a full-pallet oven shipped LTL freight —
 * only the input numbers differ.
 */
export function recalculateProductFinancials(input: ProductFinancialsInput): ProductFinancialsResult {
  const totalLandedCost = computeLandedCost(
    input.acquisitionCost,
    input.freightCost,
    input.importTaxesOrFees,
    input.packagingCost,
    input.shrinkageLossRate
  );

  const distributorPrice = computeTierPrice(totalLandedCost, input.markupDistributor, input.distributorPriceOverride);
  const contractorPrice = computeTierPrice(totalLandedCost, input.markupContractor, input.contractorPriceOverride);
  const retailPrice = computeTierPrice(totalLandedCost, input.markupRetail, input.retailPriceOverride);

  const netProfitDist = computeNetProfit(distributorPrice, totalLandedCost, input.paymentProcessingFeeRate);
  const netProfitCont = computeNetProfit(contractorPrice, totalLandedCost, input.paymentProcessingFeeRate);
  const netProfitRet = computeNetProfit(retailPrice, totalLandedCost, input.paymentProcessingFeeRate);

  return {
    totalLandedCost,
    distributorPrice,
    contractorPrice,
    retailPrice,
    netProfitDist,
    netProfitCont,
    netProfitRet,
    trueMarginDist: computeTrueMarginPct(netProfitDist, distributorPrice),
    trueMarginCont: computeTrueMarginPct(netProfitCont, contractorPrice),
    trueMarginRet: computeTrueMarginPct(netProfitRet, retailPrice),
  };
}
