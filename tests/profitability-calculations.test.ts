import { describe, it, expect } from 'vitest';
import {
  computeLineProfitability,
  summarizeProfitability,
  type ProductCostInfo,
  type LineProfitability,
} from '../src/lib/profitability';

/**
 * Phase 6 (Product Cost & Profitability Reporting): pure-function tests for
 * line-level and aggregate profitability math. No database needed.
 */
describe('computeLineProfitability', () => {
  it('revenue is quantity * unitPrice - discount, matching src/lib/totals.ts per-line math', () => {
    const costMap = new Map<string, ProductCostInfo>([['p1', { unitCost: 5, source: 'standard_cost' }]]);
    const line = computeLineProfitability({ productId: 'p1', quantity: 3, unitPrice: 20, discount: 6, description: 'Widget' }, costMap);
    expect(line.revenue).toBe(54); // 3*20 - 6
  });

  it('cogs is unitCost * quantity when a cost is resolved', () => {
    const costMap = new Map<string, ProductCostInfo>([['p1', { unitCost: 7.5, source: 'purchase_history' }]]);
    const line = computeLineProfitability({ productId: 'p1', quantity: 4, unitPrice: 20, discount: 0, description: 'Widget' }, costMap);
    expect(line.cogs).toBe(30);
    expect(line.costSource).toBe('purchase_history');
  });

  it('a line with no productId and description "Shipping" has cogs 0, not null — it is not a cost-unknown case', () => {
    const costMap = new Map<string, ProductCostInfo>();
    const line = computeLineProfitability({ productId: null, quantity: 1, unitPrice: 15, discount: 0, description: 'Shipping' }, costMap);
    expect(line.cogs).toBe(0);
    expect(line.costSource).toBe('not_applicable');
    expect(line.revenue).toBe(15);
  });

  it('a line with no productId and a description OTHER than "Shipping" is real, unmapped product revenue — cogs unknown, never a silent 0', () => {
    // Regression test: this is exactly what real WooCommerce data looks like
    // for an order line whose SKU never resolved to a productId (see
    // docs/WOOCOMMERCE_INTEGRATION.md, "unknown SKU" warning) — a genuine
    // product sale, not a shipping charge. Verified against production data
    // during the Phase 6 deploy, where every synced order line had
    // productId: null and a real product description (e.g. "Vesuvius Super
    // Patch 3000 Mortar"), which the original implementation silently
    // reported as $0 COGS / 100% margin instead of unknown.
    const costMap = new Map<string, ProductCostInfo>();
    const line = computeLineProfitability(
      { productId: null, quantity: 2, unitPrice: 149, discount: 0, description: 'Vesuvius Super Patch 3000 Mortar' },
      costMap
    );
    expect(line.cogs).toBeNull();
    expect(line.unitCost).toBeNull();
    expect(line.costSource).toBe('unknown');
    expect(line.revenue).toBe(298);
  });

  it('a real product absent from the cost map has cogs null and costSource "unknown" — never silently 0', () => {
    const costMap = new Map<string, ProductCostInfo>();
    const line = computeLineProfitability({ productId: 'p-unknown', quantity: 5, unitPrice: 10, discount: 0, description: 'Widget' }, costMap);
    expect(line.cogs).toBeNull();
    expect(line.unitCost).toBeNull();
    expect(line.costSource).toBe('unknown');
  });

  it('a product explicitly mapped to unitCost: null is treated the same as absent — unknown, not zero', () => {
    const costMap = new Map<string, ProductCostInfo>([['p1', { unitCost: null, source: 'unknown' }]]);
    const line = computeLineProfitability({ productId: 'p1', quantity: 5, unitPrice: 10, discount: 0, description: 'Widget' }, costMap);
    expect(line.cogs).toBeNull();
  });
});

describe('summarizeProfitability', () => {
  function line(revenue: number, cogs: number | null): LineProfitability {
    return { revenue, cogs, unitCost: null, costSource: cogs === null ? 'unknown' : 'standard_cost' };
  }

  it('sums revenue and cogs across fully-known lines', () => {
    const summary = summarizeProfitability([line(100, 40), line(50, 10)]);
    expect(summary.revenue).toBe(150);
    expect(summary.cogs).toBe(50);
    expect(summary.grossProfit).toBe(100);
    expect(summary.hasUnknownCost).toBe(false);
  });

  it('gross margin % = (grossProfit / revenue) * 100', () => {
    const summary = summarizeProfitability([line(200, 50)]);
    expect(summary.grossMarginPercent).toBe(75);
  });

  it('100% margin when cogs is exactly zero (a real, known zero cost, not "unknown")', () => {
    const summary = summarizeProfitability([line(100, 0)]);
    expect(summary.cogs).toBe(0);
    expect(summary.grossProfit).toBe(100);
    expect(summary.grossMarginPercent).toBe(100);
  });

  it('negative margin (a loss) when cogs exceeds revenue', () => {
    const summary = summarizeProfitability([line(50, 80)]);
    expect(summary.grossProfit).toBe(-30);
    expect(summary.grossMarginPercent).toBe(-60);
  });

  it('zero revenue: margin is null (mathematically undefined), never 0% or Infinity', () => {
    const summary = summarizeProfitability([line(0, 0)]);
    expect(summary.revenue).toBe(0);
    expect(summary.grossProfit).toBe(0);
    expect(summary.grossMarginPercent).toBeNull();
  });

  it('zero revenue with a nonzero known cost: margin is still null, not -Infinity', () => {
    const summary = summarizeProfitability([line(0, 25)]);
    expect(summary.grossMarginPercent).toBeNull();
    expect(summary.grossProfit).toBe(-25);
  });

  it('an empty line list summarizes to all zeros, not a crash', () => {
    const summary = summarizeProfitability([]);
    expect(summary.revenue).toBe(0);
    expect(summary.cogs).toBe(0);
    expect(summary.grossProfit).toBe(0);
    expect(summary.grossMarginPercent).toBeNull();
    expect(summary.hasUnknownCost).toBe(false);
  });

  it('one unknown-cost line makes the whole aggregate cogs/grossProfit/margin null, never silently understated', () => {
    const summary = summarizeProfitability([line(100, 40), line(50, null)]);
    expect(summary.hasUnknownCost).toBe(true);
    expect(summary.cogs).toBeNull();
    expect(summary.grossProfit).toBeNull();
    expect(summary.grossMarginPercent).toBeNull();
  });

  it('knownCogs/partialGrossProfit stay computable ("at least this much") even when cogs is null', () => {
    const summary = summarizeProfitability([line(100, 40), line(50, null)]);
    expect(summary.knownCogs).toBe(40);
    expect(summary.partialGrossProfit).toBe(110); // 150 revenue - 40 known cogs
    expect(summary.unknownCostRevenue).toBe(50);
    expect(summary.unknownCostLineCount).toBe(1);
  });

  it('non-product lines (cogs: 0, costSource not_applicable) never trigger hasUnknownCost', () => {
    const shippingLine: LineProfitability = { revenue: 15, cogs: 0, unitCost: null, costSource: 'not_applicable' };
    const summary = summarizeProfitability([line(100, 40), shippingLine]);
    expect(summary.hasUnknownCost).toBe(false);
    expect(summary.cogs).toBe(40);
    expect(summary.revenue).toBe(115);
  });

  it('multiple unknown-cost lines accumulate unknownCostRevenue and unknownCostLineCount', () => {
    const summary = summarizeProfitability([line(30, null), line(70, null), line(100, 25)]);
    expect(summary.unknownCostRevenue).toBe(100);
    expect(summary.unknownCostLineCount).toBe(2);
    expect(summary.knownCogs).toBe(25);
  });
});
