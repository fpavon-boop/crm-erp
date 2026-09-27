import type { MarketingSafeguardVerdict } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { toNumber } from '@/lib/format';
import { getProductCostMap, type CostSource, type ProductCostInfo } from '@/lib/profitability';
import { STOCK_HOLDING_STATUSES } from '@/lib/automations/stock';

/**
 * Read-only ERP intelligence for the marketing module
 * (docs/MARKETING_AUTOMATION_ARCHITECTURE.md §3).
 *
 * STRICTLY READ-ONLY: every query here is findUnique/findMany against core
 * tables, or a call into an existing read-only core helper
 * (getProductCostMap). Nothing in this file creates, updates or deletes any
 * row — tests/marketing-safeguards.test.ts snapshots row counts across all
 * calls and a static check forbids write methods in this file.
 *
 * Every check fails closed: a missing product, unknown cost, zero price or
 * invalid discount is a BLOCK, never a silent pass.
 */

export interface SafeguardPolicy {
  /** Minimum net margin on the promotional price, in percent. */
  minMarginPct: number;
  /** Minimum units that must remain available to run a promotion at all. */
  minPromotableStock: number;
  /** Extra units held back on top of minPromotableStock. */
  safetyBufferUnits: number;
}

/** Confirmed 2026-09-27 (architecture doc §6). */
export const DEFAULT_SAFEGUARD_POLICY: Readonly<SafeguardPolicy> = Object.freeze({
  minMarginPct: 25,
  minPromotableStock: 2,
  safetyBufferUnits: 1,
});

export type SafeguardIssueCode =
  | 'PRODUCT_NOT_FOUND'
  | 'PRODUCT_INACTIVE'
  | 'INSUFFICIENT_STOCK'
  | 'AT_OR_BELOW_REORDER_POINT'
  | 'INVENTORY_NOT_TRACKED'
  | 'INVALID_DISCOUNT'
  | 'INVALID_PRICE'
  | 'COST_UNKNOWN'
  | 'COST_FROM_STANDARD_COST'
  | 'MARGIN_BELOW_MINIMUM';

export interface SafeguardIssue {
  code: SafeguardIssueCode;
  severity: 'WARN' | 'BLOCK';
  message: string;
}

function verdictOf(issues: SafeguardIssue[]): MarketingSafeguardVerdict {
  if (issues.some((i) => i.severity === 'BLOCK')) return 'BLOCK';
  if (issues.length > 0) return 'WARN';
  return 'PASS';
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

// Floating-point slack so a margin of exactly 25% isn't rejected as 24.999…%.
const EPSILON = 1e-9;

// =============================================================================
// 1. Inventory
// =============================================================================

export interface InventoryStatus {
  productId: string;
  verdict: MarketingSafeguardVerdict;
  issues: SafeguardIssue[];
  trackInventory: boolean;
  /** Sum of StockLevel.quantity over active variants in active warehouses. */
  onHand: number;
  /** Units on DRAFT sales orders — not yet deducted from StockLevel, but
   * promised (decision 1: drafts count against promotable stock). */
  draftCommitted: number;
  /** onHand − draftCommitted (may be negative). */
  available: number;
  /** minPromotableStock + safetyBufferUnits. */
  requiredMinimum: number;
  reorderPoint: number;
}

async function loadInventoryStatuses(
  productIds: string[],
  policy: SafeguardPolicy
): Promise<Map<string, InventoryStatus>> {
  const ids = Array.from(new Set(productIds));
  const [products, draftItems] = await Promise.all([
    prisma.product.findMany({
      where: { id: { in: ids } },
      select: {
        id: true,
        active: true,
        trackInventory: true,
        reorderPoint: true,
        variants: {
          where: { active: true },
          select: { stockLevels: { where: { warehouse: { active: true } }, select: { quantity: true } } },
        },
      },
    }),
    // Stock is only deducted when an order leaves DRAFT (STOCK_HOLDING_STATUSES
    // in src/lib/automations/stock.ts), so DRAFT lines are the only
    // commitments not already reflected in StockLevel.
    prisma.salesOrderItem.findMany({
      where: { productId: { in: ids }, salesOrder: { status: 'DRAFT' } },
      select: { productId: true, quantity: true },
    }),
  ]);

  const drafts = new Map<string, number>();
  for (const item of draftItems) {
    if (!item.productId) continue;
    drafts.set(item.productId, (drafts.get(item.productId) ?? 0) + toNumber(item.quantity));
  }

  const requiredMinimum = policy.minPromotableStock + policy.safetyBufferUnits;
  const byId = new Map(products.map((p) => [p.id, p]));
  const result = new Map<string, InventoryStatus>();

  for (const id of ids) {
    const p = byId.get(id);
    const issues: SafeguardIssue[] = [];
    if (!p) {
      issues.push({ code: 'PRODUCT_NOT_FOUND', severity: 'BLOCK', message: 'Product does not exist.' });
      result.set(id, {
        productId: id,
        verdict: 'BLOCK',
        issues,
        trackInventory: false,
        onHand: 0,
        draftCommitted: 0,
        available: 0,
        requiredMinimum,
        reorderPoint: 0,
      });
      continue;
    }

    const onHand = p.variants.reduce((sum, v) => sum + v.stockLevels.reduce((s, l) => s + l.quantity, 0), 0);
    const draftCommitted = round2(drafts.get(id) ?? 0);
    const available = round2(onHand - draftCommitted);

    if (!p.active) {
      issues.push({ code: 'PRODUCT_INACTIVE', severity: 'BLOCK', message: 'Product is inactive.' });
    }
    if (!p.trackInventory) {
      issues.push({
        code: 'INVENTORY_NOT_TRACKED',
        severity: 'WARN',
        message: 'Inventory is not tracked for this product; availability cannot be verified.',
      });
    } else if (available < requiredMinimum) {
      issues.push({
        code: 'INSUFFICIENT_STOCK',
        severity: 'BLOCK',
        message: `Available ${available} (on hand ${onHand} − drafts ${draftCommitted}) is below the required ${requiredMinimum} (min ${policy.minPromotableStock} + buffer ${policy.safetyBufferUnits}).`,
      });
    } else if (p.reorderPoint > 0 && available <= p.reorderPoint) {
      issues.push({
        code: 'AT_OR_BELOW_REORDER_POINT',
        severity: 'WARN',
        message: `Available ${available} is at or below the reorder point (${p.reorderPoint}); a promotion may trigger a stock-out.`,
      });
    }

    result.set(id, {
      productId: id,
      verdict: verdictOf(issues),
      issues,
      trackInventory: p.trackInventory,
      onHand,
      draftCommitted,
      available,
      requiredMinimum,
      reorderPoint: p.reorderPoint,
    });
  }
  return result;
}

export async function checkInventoryStatus(
  productId: string,
  policy: SafeguardPolicy = DEFAULT_SAFEGUARD_POLICY
): Promise<InventoryStatus> {
  const map = await loadInventoryStatuses([productId], policy);
  return map.get(productId)!;
}

// =============================================================================
// 2. Margin
// =============================================================================

export interface MarginViability {
  productId: string;
  verdict: MarketingSafeguardVerdict;
  issues: SafeguardIssue[];
  listPrice: number | null;
  discountPct: number;
  promoPrice: number | null;
  unitCost: number | null;
  costSource: CostSource | null;
  /** (promoPrice − unitCost) / promoPrice × 100, rounded to 2dp. */
  marginPct: number | null;
  minMarginPct: number;
  /** Largest discount that still meets minMarginPct (0 if none does). */
  maxDiscountPct: number | null;
}

/**
 * Pure margin evaluation, exported for unit tests and for batch callers that
 * already hold a cost map. Price is Product.price (pre-tax, as used across
 * Profitability reporting); sales tax never counts as revenue.
 */
export function evaluateMargin(params: {
  productId: string;
  listPrice: number | null;
  discountPct: number;
  cost: ProductCostInfo | undefined;
  minMarginPct: number;
}): MarginViability {
  const { productId, listPrice, discountPct, cost, minMarginPct } = params;
  const issues: SafeguardIssue[] = [];
  const base = {
    productId,
    listPrice,
    discountPct,
    unitCost: cost?.unitCost ?? null,
    costSource: cost?.source ?? null,
    minMarginPct,
  };

  if (!Number.isFinite(discountPct) || discountPct < 0 || discountPct >= 100) {
    issues.push({ code: 'INVALID_DISCOUNT', severity: 'BLOCK', message: 'Discount must be ≥ 0% and < 100%.' });
  }
  if (listPrice === null || !(listPrice > 0)) {
    issues.push({ code: 'INVALID_PRICE', severity: 'BLOCK', message: 'Product has no positive list price.' });
  }
  if (!cost || cost.unitCost === null) {
    issues.push({
      code: 'COST_UNKNOWN',
      severity: 'BLOCK',
      message: 'Unit cost is unknown (no purchase history and no manual cost); margin cannot be verified.',
    });
  } else if (cost.source === 'standard_cost') {
    issues.push({
      code: 'COST_FROM_STANDARD_COST',
      severity: 'WARN',
      message: 'No purchase history; margin uses the manually entered product cost.',
    });
  }

  if (issues.some((i) => i.severity === 'BLOCK')) {
    const computable = listPrice !== null && listPrice > 0 && cost?.unitCost != null;
    return {
      ...base,
      verdict: 'BLOCK',
      issues,
      promoPrice: null,
      marginPct: null,
      maxDiscountPct: computable ? maxDiscount(listPrice!, cost!.unitCost!, minMarginPct) : null,
    };
  }

  const unitCost = cost!.unitCost!;
  const promoPrice = listPrice! * (1 - discountPct / 100);
  const margin = (promoPrice - unitCost) / promoPrice;
  if (margin + EPSILON < minMarginPct / 100) {
    issues.push({
      code: 'MARGIN_BELOW_MINIMUM',
      severity: 'BLOCK',
      message: `Margin at ${discountPct}% off is ${round2(margin * 100)}%, below the ${minMarginPct}% minimum.`,
    });
  }

  return {
    ...base,
    verdict: verdictOf(issues),
    issues,
    promoPrice: round2(promoPrice),
    marginPct: round2(margin * 100),
    maxDiscountPct: maxDiscount(listPrice!, unitCost, minMarginPct),
  };
}

/** Solves (P(1−d) − C) / (P(1−d)) ≥ m for d: d ≤ 1 − C / (P(1−m)).
 * Floored to 2dp so the returned value always passes. */
function maxDiscount(listPrice: number, unitCost: number, minMarginPct: number): number {
  const m = minMarginPct / 100;
  if (m >= 1) return 0;
  const d = 1 - unitCost / (listPrice * (1 - m));
  // EPSILON absorbs float error (1 − 60/75 = 0.19999999999999996) so an
  // exact answer isn't floored a cent short; the result still passes because
  // the margin comparison applies the same slack.
  return d <= 0 ? 0 : Math.floor(d * 10000 + EPSILON * 1000) / 100;
}

export async function checkMarginViability(
  productId: string,
  proposedDiscountPercent: number,
  options: { policy?: SafeguardPolicy; costMap?: Map<string, ProductCostInfo> } = {}
): Promise<MarginViability> {
  const policy = options.policy ?? DEFAULT_SAFEGUARD_POLICY;
  const product = await prisma.product.findUnique({ where: { id: productId }, select: { id: true, price: true } });
  if (!product) {
    return {
      productId,
      verdict: 'BLOCK',
      issues: [{ code: 'PRODUCT_NOT_FOUND', severity: 'BLOCK', message: 'Product does not exist.' }],
      listPrice: null,
      discountPct: proposedDiscountPercent,
      promoPrice: null,
      unitCost: null,
      costSource: null,
      marginPct: null,
      minMarginPct: policy.minMarginPct,
      maxDiscountPct: null,
    };
  }
  // Reuses the one canonical cost resolution (purchase-history weighted
  // average → manual cost → unknown) so marketing and Profitability
  // reporting can never disagree about a product's cost.
  const costMap = options.costMap ?? (await getProductCostMap());
  return evaluateMargin({
    productId,
    listPrice: toNumber(product.price),
    discountPct: proposedDiscountPercent,
    cost: costMap.get(productId),
    minMarginPct: policy.minMarginPct,
  });
}

// =============================================================================
// 3. Top performers
// =============================================================================

export interface TopProduct {
  productId: string;
  sku: string;
  name: string;
  unitsSold: number;
  revenue: number;
  orderCount: number;
  /** Units sold per day over the lookback window. */
  velocityPerDay: number;
  /** Margin at current list price (no discount); null when cost unknown. */
  currentMarginPct: number | null;
  costSource: CostSource;
  inventory: InventoryStatus;
}

/**
 * Ranks active products by units sold on realised orders (CONFIRMED,
 * SHIPPED, DELIVERED — the same "actually sold" statuses Profitability and
 * the Dashboard use; DRAFT, CANCELLED and REFUNDED excluded) over the last
 * `lookbackDays`. Ties break on revenue. "High-converting" is approximated by
 * sales velocity: the CRM has no traffic/view data to compute a true
 * conversion rate.
 *
 * Each row carries its inventory safeguard so callers can drop BLOCKed items
 * before suggesting them.
 */
export async function getTopPerformingProducts(
  limit: number,
  options: { lookbackDays?: number; policy?: SafeguardPolicy; now?: Date } = {}
): Promise<TopProduct[]> {
  const take = Math.max(1, Math.min(50, Math.floor(limit) || 1));
  const lookbackDays = Math.max(1, Math.floor(options.lookbackDays ?? 90));
  const policy = options.policy ?? DEFAULT_SAFEGUARD_POLICY;
  const until = options.now ?? new Date();
  const since = new Date(until.getTime() - lookbackDays * 24 * 60 * 60 * 1000);

  const items = await prisma.salesOrderItem.findMany({
    where: {
      productId: { not: null },
      product: { active: true },
      salesOrder: { status: { in: Array.from(STOCK_HOLDING_STATUSES) }, createdAt: { gte: since, lte: until } },
    },
    select: { productId: true, salesOrderId: true, quantity: true, unitPrice: true, discount: true },
  });

  const agg = new Map<string, { units: number; revenue: number; orders: Set<string> }>();
  for (const it of items) {
    const id = it.productId!;
    const qty = toNumber(it.quantity);
    const entry = agg.get(id) ?? { units: 0, revenue: 0, orders: new Set<string>() };
    entry.units += qty;
    entry.revenue += qty * toNumber(it.unitPrice) - toNumber(it.discount);
    entry.orders.add(it.salesOrderId);
    agg.set(id, entry);
  }

  const ranked = Array.from(agg.entries())
    .sort((a, b) => b[1].units - a[1].units || b[1].revenue - a[1].revenue)
    .slice(0, take);
  if (ranked.length === 0) return [];

  const ids = ranked.map(([id]) => id);
  const [products, costMap, inventory] = await Promise.all([
    prisma.product.findMany({ where: { id: { in: ids } }, select: { id: true, sku: true, name: true, price: true } }),
    getProductCostMap(),
    loadInventoryStatuses(ids, policy),
  ]);
  const productById = new Map(products.map((p) => [p.id, p]));

  return ranked.map(([id, a]) => {
    const p = productById.get(id)!;
    const price = toNumber(p.price);
    const cost = costMap.get(id) ?? { unitCost: null, source: 'unknown' as const };
    return {
      productId: id,
      sku: p.sku,
      name: p.name,
      unitsSold: round2(a.units),
      revenue: round2(a.revenue),
      orderCount: a.orders.size,
      velocityPerDay: round2(a.units / lookbackDays),
      currentMarginPct: cost.unitCost !== null && price > 0 ? round2(((price - cost.unitCost) / price) * 100) : null,
      costSource: cost.source,
      inventory: inventory.get(id)!,
    };
  });
}
