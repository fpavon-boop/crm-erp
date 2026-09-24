import { prisma } from '@/lib/prisma';
import { Prisma, type SalesOrderStatus, type InvoiceStatus } from '@prisma/client';
import { toNumber } from '@/lib/format';
import { STOCK_HOLDING_STATUSES } from '@/lib/automations/stock';

type Db = typeof prisma | Prisma.TransactionClient;

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

// =============================================================================
// Product cost resolution
// =============================================================================

export type CostSource = 'purchase_history' | 'standard_cost' | 'unknown';

export interface ProductCostInfo {
  unitCost: number | null;
  source: CostSource;
}

/**
 * Resolves one unit cost per Product, in priority order:
 *
 * 1. **Purchase history** — a quantity-weighted average of `unitCost` across
 *    every `GoodsReceiptItem` actually received against a `PurchaseOrderItem`
 *    for that product. This is the strongest signal: it's what was actually
 *    paid, not a manually-typed estimate, and a weighted average (rather
 *    than "most recent") is resistant to a single outlier receipt skewing
 *    the figure.
 * 2. **Standard cost** — `Product.cost`, but only when it's greater than
 *    zero. `Product.cost` defaults to `0` for every product, so a `0` here
 *    is indistinguishable from "never set" — treating it as a real cost
 *    would silently under-report COGS (and over-report margin) for any
 *    product no one has priced yet. See docs/PROFITABILITY_REPORTING.md
 *    "Accounting assumptions" for why zero is never inferred as a real
 *    cost.
 * 3. **Unknown** — neither source has a usable value. Every caller of this
 *    map must treat `unitCost: null` as "cannot compute," never as `0` (see
 *    computeLineProfitability / summarizeProfitability below).
 */
export async function getProductCostMap(db: Db = prisma): Promise<Map<string, ProductCostInfo>> {
  const [products, receiptRows] = await Promise.all([
    db.product.findMany({ select: { id: true, cost: true } }),
    db.goodsReceiptItem.findMany({
      where: { purchaseOrderItemId: { not: null } },
      select: { quantity: true, purchaseOrderItem: { select: { productId: true, unitCost: true } } },
    }),
  ]);

  const weighted = new Map<string, { qty: number; costSum: number }>();
  for (const r of receiptRows) {
    const productId = r.purchaseOrderItem?.productId;
    if (!productId) continue;
    const qty = toNumber(r.quantity);
    if (qty <= 0) continue;
    const unitCost = toNumber(r.purchaseOrderItem!.unitCost);
    const entry = weighted.get(productId) ?? { qty: 0, costSum: 0 };
    entry.qty += qty;
    entry.costSum += qty * unitCost;
    weighted.set(productId, entry);
  }

  const map = new Map<string, ProductCostInfo>();
  for (const p of products) {
    const w = weighted.get(p.id);
    if (w && w.qty > 0) {
      map.set(p.id, { unitCost: round2(w.costSum / w.qty), source: 'purchase_history' });
      continue;
    }
    const standardCost = toNumber(p.cost);
    if (standardCost > 0) {
      map.set(p.id, { unitCost: standardCost, source: 'standard_cost' });
    } else {
      map.set(p.id, { unitCost: null, source: 'unknown' });
    }
  }
  return map;
}

// =============================================================================
// Line-level and aggregate profitability
// =============================================================================

/** The exact, literal description WooCommerce-sourced shipping charges are
 * imported under (`buildOrderItemsData()` in src/lib/wordpress/woocommerce.ts)
 * — the ONLY case where a line legitimately has no productId and no COGS
 * question to answer. Any other productId-less line is real, unmapped
 * product revenue (an "unknown SKU" the sync warned about but still
 * imported — see docs/WOOCOMMERCE_INTEGRATION.md) and its cost must be
 * treated as unknown, never silently zero. */
const SHIPPING_LINE_DESCRIPTION = 'Shipping';

export interface ProfitabilityLineInput {
  productId: string | null;
  quantity: number;
  unitPrice: number;
  discount: number;
  description: string;
}

export interface LineProfitability {
  revenue: number;
  /** null for a product whose cost could not be resolved (including a
   * product WooCommerce couldn't map to any productId at all — see
   * costSource). `0` only for the one genuinely non-product line type
   * (shipping) — there is no COGS question to answer for it, so it must
   * never make an aggregate look "incomplete." */
  cogs: number | null;
  unitCost: number | null;
  costSource: CostSource | 'not_applicable';
}

/** quantity * unitPrice - discount — pre-tax net revenue for one order/invoice
 * line, matching the same per-line math src/lib/totals.ts uses to build
 * subtotal/discountTotal (so this always agrees with the invoice/order's own
 * stored totals; see docs/PROFITABILITY_REPORTING.md). Sales tax is never
 * part of revenue — it's collected on behalf of a tax authority, not earned. */
export function computeLineProfitability(
  line: ProfitabilityLineInput,
  costMap: Map<string, ProductCostInfo>
): LineProfitability {
  const revenue = round2(line.quantity * line.unitPrice - line.discount);
  if (!line.productId) {
    if (line.description === SHIPPING_LINE_DESCRIPTION) {
      return { revenue, cogs: 0, unitCost: null, costSource: 'not_applicable' };
    }
    // A real product line WooCommerce (or a manual entry) never linked to a
    // productId — e.g. an unresolved SKU (docs/WOOCOMMERCE_INTEGRATION.md).
    // This is real product revenue with a genuinely unknown cost, not a
    // non-product line — never coerced to a silent $0.
    return { revenue, cogs: null, unitCost: null, costSource: 'unknown' };
  }
  const info = costMap.get(line.productId);
  if (!info || info.unitCost === null) {
    return { revenue, cogs: null, unitCost: null, costSource: 'unknown' };
  }
  return { revenue, cogs: round2(info.unitCost * line.quantity), unitCost: info.unitCost, costSource: info.source };
}

export interface ProfitabilitySummary {
  revenue: number;
  /** Sum of every line's cogs where it was actually determinable (0 for
   * non-product lines, a real figure for cost-resolved product lines).
   * Always computable — this is the "at least this much" cost floor. */
  knownCogs: number;
  /** Equals knownCogs when every product line resolved a cost; null the
   * instant even one product line's cost is unknown — the TRUE total COGS
   * is not a smaller number in that case, it's an unknown one, and this
   * field must never silently understate it as knownCogs. */
  cogs: number | null;
  /** revenue - knownCogs. Always computable, for "at least $X profit" UI
   * framing even when the true (complete-cost) figure is indeterminate. */
  partialGrossProfit: number;
  /** null whenever cogs is null, for the same reason. */
  grossProfit: number | null;
  /** null when cogs is null, OR when revenue is exactly 0 (margin % is
   * mathematically undefined with no revenue to divide by — never reported
   * as 0% or as +/-Infinity). See docs/PROFITABILITY_REPORTING.md "Edge
   * cases." */
  grossMarginPercent: number | null;
  hasUnknownCost: boolean;
  /** Revenue attributable to lines whose cost is unknown — lets a caller
   * show "$X of $Y revenue has no determinable cost" instead of just a
   * boolean. */
  unknownCostRevenue: number;
  unknownCostLineCount: number;
}

export function summarizeProfitability(lines: LineProfitability[]): ProfitabilitySummary {
  let revenue = 0;
  let knownCogs = 0;
  let unknownCostRevenue = 0;
  let unknownCostLineCount = 0;
  let hasUnknownCost = false;

  for (const l of lines) {
    revenue += l.revenue;
    if (l.cogs === null) {
      hasUnknownCost = true;
      unknownCostRevenue += l.revenue;
      unknownCostLineCount += 1;
    } else {
      knownCogs += l.cogs;
    }
  }

  revenue = round2(revenue);
  knownCogs = round2(knownCogs);
  unknownCostRevenue = round2(unknownCostRevenue);
  const partialGrossProfit = round2(revenue - knownCogs);
  const cogs = hasUnknownCost ? null : knownCogs;
  const grossProfit = hasUnknownCost ? null : partialGrossProfit;
  const grossMarginPercent =
    grossProfit === null ? null : revenue === 0 ? null : round2((grossProfit / revenue) * 100);

  return {
    revenue,
    knownCogs,
    cogs,
    partialGrossProfit,
    grossProfit,
    grossMarginPercent,
    hasUnknownCost,
    unknownCostRevenue,
    unknownCostLineCount,
  };
}

// =============================================================================
// Level-specific aggregations
// =============================================================================

export interface DateRangeFilter {
  from?: Date;
  to?: Date;
}

function dateRangeWhere(filters: DateRangeFilter): { gte?: Date; lte?: Date } | undefined {
  if (!filters.from && !filters.to) return undefined;
  const where: { gte?: Date; lte?: Date } = {};
  if (filters.from) where.gte = filters.from;
  if (filters.to) where.lte = filters.to;
  return where;
}

interface ScoredOrderLine extends LineProfitability {
  orderId: string;
  orderNumber: string;
  orderStatus: SalesOrderStatus;
  orderCreatedAt: Date;
  companyId: string | null;
  companyName: string | null;
  productId: string | null;
  sku: string | null;
  productName: string | null;
  quantity: number;
}

/**
 * The single query Product/Order/Customer/Month profitability are all
 * derived from — one read, four ways of looking at it, so those four views
 * can never disagree with each other about total revenue (the same
 * discipline docs/CUSTOMER_360.md and docs/ACCOUNTS_RECEIVABLE.md already
 * apply). Scoped to sales orders in a stock-holding status
 * (CONFIRMED/SHIPPED/DELIVERED) — the same "actually sold" definition
 * src/lib/finance.ts already uses for its "Orders sold" figure. DRAFT
 * orders were never sold; CANCELLED orders were reversed.
 */
async function fetchScoredOrderLines(filters: DateRangeFilter, db: Db): Promise<ScoredOrderLine[]> {
  const costMap = await getProductCostMap(db);
  const createdAt = dateRangeWhere(filters);

  const orders = await db.salesOrder.findMany({
    where: {
      status: { in: [...STOCK_HOLDING_STATUSES] },
      ...(createdAt ? { createdAt } : {}),
    },
    select: {
      id: true,
      number: true,
      status: true,
      createdAt: true,
      companyId: true,
      company: { select: { name: true } },
      items: {
        select: {
          productId: true,
          quantity: true,
          unitPrice: true,
          discount: true,
          description: true,
          product: { select: { sku: true, name: true } },
        },
      },
    },
  });

  const lines: ScoredOrderLine[] = [];
  for (const o of orders) {
    for (const item of o.items) {
      const quantity = toNumber(item.quantity);
      const profit = computeLineProfitability(
        {
          productId: item.productId,
          quantity,
          unitPrice: toNumber(item.unitPrice),
          discount: toNumber(item.discount),
          description: item.description,
        },
        costMap
      );
      lines.push({
        ...profit,
        orderId: o.id,
        orderNumber: o.number,
        orderStatus: o.status,
        orderCreatedAt: o.createdAt,
        companyId: o.companyId,
        companyName: o.company?.name ?? null,
        productId: item.productId,
        sku: item.product?.sku ?? null,
        productName: item.product?.name ?? null,
        quantity,
      });
    }
  }
  return lines;
}

export interface ProductProfitabilityRow {
  productId: string;
  sku: string;
  name: string;
  quantitySold: number;
  summary: ProfitabilitySummary;
}

export interface SalesOrderProfitabilityRow {
  orderId: string;
  number: string;
  status: SalesOrderStatus;
  createdAt: Date;
  companyId: string | null;
  companyName: string | null;
  summary: ProfitabilitySummary;
}

export interface CustomerProfitabilityRow {
  companyId: string | null;
  companyName: string;
  orderCount: number;
  summary: ProfitabilitySummary;
}

export interface MonthlyProfitabilityRow {
  key: string;
  label: string;
  summary: ProfitabilitySummary;
}

function monthKeyOf(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function monthLabelOf(d: Date): string {
  return d.toLocaleDateString('en-US', { month: 'short', year: 'numeric' });
}

/** Product-level profitability (requirement level 1 of 5): every
 * stock-holding sales order line grouped by product. Non-product lines
 * (shipping) are excluded here — there is no "product" to attribute them
 * to — but still counted in Order/Customer/Month totals below. */
export async function getProductProfitability(
  filters: DateRangeFilter = {},
  db: Db = prisma
): Promise<ProductProfitabilityRow[]> {
  const lines = await fetchScoredOrderLines(filters, db);
  const groups = new Map<string, { sku: string; name: string; quantity: number; lines: LineProfitability[] }>();
  for (const l of lines) {
    if (!l.productId) continue;
    const g = groups.get(l.productId) ?? { sku: l.sku ?? '—', name: l.productName ?? 'Unknown product', quantity: 0, lines: [] };
    g.quantity += l.quantity;
    g.lines.push(l);
    groups.set(l.productId, g);
  }
  const rows: ProductProfitabilityRow[] = [];
  for (const [productId, g] of groups) {
    rows.push({ productId, sku: g.sku, name: g.name, quantitySold: round2(g.quantity), summary: summarizeProfitability(g.lines) });
  }
  return rows.sort((a, b) => b.summary.revenue - a.summary.revenue);
}

/** Sales Order-level profitability (requirement level 2 of 5): revenue/COGS
 * summed per order across all of that order's lines (including shipping). */
export async function getSalesOrderProfitability(
  filters: DateRangeFilter = {},
  db: Db = prisma
): Promise<SalesOrderProfitabilityRow[]> {
  const lines = await fetchScoredOrderLines(filters, db);
  const groups = new Map<string, { number: string; status: SalesOrderStatus; createdAt: Date; companyId: string | null; companyName: string | null; lines: LineProfitability[] }>();
  for (const l of lines) {
    const g = groups.get(l.orderId) ?? {
      number: l.orderNumber,
      status: l.orderStatus,
      createdAt: l.orderCreatedAt,
      companyId: l.companyId,
      companyName: l.companyName,
      lines: [],
    };
    g.lines.push(l);
    groups.set(l.orderId, g);
  }
  const rows: SalesOrderProfitabilityRow[] = [];
  for (const [orderId, g] of groups) {
    rows.push({
      orderId,
      number: g.number,
      status: g.status,
      createdAt: g.createdAt,
      companyId: g.companyId,
      companyName: g.companyName,
      summary: summarizeProfitability(g.lines),
    });
  }
  return rows.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
}

/** Customer/Company-level profitability (requirement level 4 of 5). Orders
 * with no company on file (e.g. a WooCommerce guest checkout with only a
 * Contact) are grouped under a single "No customer assigned" bucket rather
 * than dropped — that revenue is real and should still be visible. */
export async function getCustomerProfitability(
  filters: DateRangeFilter = {},
  db: Db = prisma
): Promise<CustomerProfitabilityRow[]> {
  const lines = await fetchScoredOrderLines(filters, db);
  const groups = new Map<string, { companyName: string; orderIds: Set<string>; lines: LineProfitability[] }>();
  for (const l of lines) {
    const key = l.companyId ?? '__unassigned__';
    const g = groups.get(key) ?? { companyName: l.companyName ?? 'No customer assigned', orderIds: new Set<string>(), lines: [] };
    g.orderIds.add(l.orderId);
    g.lines.push(l);
    groups.set(key, g);
  }
  const rows: CustomerProfitabilityRow[] = [];
  for (const [key, g] of groups) {
    rows.push({
      companyId: key === '__unassigned__' ? null : key,
      companyName: g.companyName,
      orderCount: g.orderIds.size,
      summary: summarizeProfitability(g.lines),
    });
  }
  return rows.sort((a, b) => b.summary.revenue - a.summary.revenue);
}

/** Monthly-level profitability / trends (requirement level 5 of 5), grouped
 * by the order's createdAt month. Sorted chronologically (oldest first) so
 * it reads naturally as a trend. */
export async function getMonthlyProfitability(
  filters: DateRangeFilter = {},
  db: Db = prisma
): Promise<MonthlyProfitabilityRow[]> {
  const lines = await fetchScoredOrderLines(filters, db);
  const groups = new Map<string, { label: string; lines: LineProfitability[] }>();
  for (const l of lines) {
    const key = monthKeyOf(l.orderCreatedAt);
    const g = groups.get(key) ?? { label: monthLabelOf(l.orderCreatedAt), lines: [] };
    g.lines.push(l);
    groups.set(key, g);
  }
  const rows: MonthlyProfitabilityRow[] = [];
  for (const [key, g] of groups) {
    rows.push({ key, label: g.label, summary: summarizeProfitability(g.lines) });
  }
  return rows.sort((a, b) => a.key.localeCompare(b.key));
}

export interface InvoiceProfitabilityRow {
  invoiceId: string;
  number: string;
  status: InvoiceStatus;
  issueDate: Date;
  companyId: string | null;
  companyName: string | null;
  summary: ProfitabilitySummary;
}

const INVOICED_STATUSES: InvoiceStatus[] = ['SENT', 'PARTIAL', 'PAID', 'OVERDUE'];

/** Invoice-level profitability (requirement level 3 of 5) — deliberately a
 * separate query from the sales-order-based levels above, the same way
 * docs/ACCOUNTS_RECEIVABLE.md's AR module is deliberately separate from
 * src/lib/finance.ts: an Invoice can be edited, split, or diverge from the
 * SalesOrder it was generated from, so "what did we bill" and "what did we
 * sell" are genuinely different questions here, not two computations of the
 * same one. Only actually-issued INVOICE-type documents are included —
 * DRAFT (never sent) and CANCELLED (voided) are excluded, matching
 * docs/ACCOUNTS_RECEIVABLE.md's own status handling. */
export async function getInvoiceProfitability(
  filters: DateRangeFilter = {},
  db: Db = prisma
): Promise<InvoiceProfitabilityRow[]> {
  const costMap = await getProductCostMap(db);
  const issueDate = dateRangeWhere(filters);

  const invoices = await db.invoice.findMany({
    where: {
      type: 'INVOICE',
      status: { in: INVOICED_STATUSES },
      ...(issueDate ? { issueDate } : {}),
    },
    select: {
      id: true,
      number: true,
      status: true,
      issueDate: true,
      companyId: true,
      company: { select: { name: true } },
      items: { select: { productId: true, quantity: true, unitPrice: true, discount: true, description: true } },
    },
  });

  return invoices
    .map((inv) => {
      const lines = inv.items.map((item) =>
        computeLineProfitability(
          {
            productId: item.productId,
            quantity: toNumber(item.quantity),
            unitPrice: toNumber(item.unitPrice),
            discount: toNumber(item.discount),
            description: item.description,
          },
          costMap
        )
      );
      return {
        invoiceId: inv.id,
        number: inv.number,
        status: inv.status,
        issueDate: inv.issueDate,
        companyId: inv.companyId,
        companyName: inv.company?.name ?? null,
        summary: summarizeProfitability(lines),
      };
    })
    .sort((a, b) => b.summary.revenue - a.summary.revenue);
}

export interface ProfitabilityDashboard {
  filters: { from: Date | null; to: Date | null };
  overall: ProfitabilitySummary;
  byProduct: ProductProfitabilityRow[];
  byCustomer: CustomerProfitabilityRow[];
  byOrder: SalesOrderProfitabilityRow[];
  byMonth: MonthlyProfitabilityRow[];
}

/** The single entry point the dashboard page calls: one query
 * (fetchScoredOrderLines) reused across the overall total and all three
 * sales-order-based breakdowns, so every number on the page is guaranteed
 * to reconcile against every other number on the page. */
export async function getProfitabilityDashboard(
  filters: DateRangeFilter = {},
  db: Db = prisma
): Promise<ProfitabilityDashboard> {
  const lines = await fetchScoredOrderLines(filters, db);

  const productGroups = new Map<string, { sku: string; name: string; quantity: number; lines: LineProfitability[] }>();
  const orderGroups = new Map<string, { number: string; status: SalesOrderStatus; createdAt: Date; companyId: string | null; companyName: string | null; lines: LineProfitability[] }>();
  const customerGroups = new Map<string, { companyName: string; orderIds: Set<string>; lines: LineProfitability[] }>();
  const monthGroups = new Map<string, { label: string; lines: LineProfitability[] }>();

  for (const l of lines) {
    if (l.productId) {
      const g = productGroups.get(l.productId) ?? { sku: l.sku ?? '—', name: l.productName ?? 'Unknown product', quantity: 0, lines: [] };
      g.quantity += l.quantity;
      g.lines.push(l);
      productGroups.set(l.productId, g);
    }

    const og = orderGroups.get(l.orderId) ?? {
      number: l.orderNumber,
      status: l.orderStatus,
      createdAt: l.orderCreatedAt,
      companyId: l.companyId,
      companyName: l.companyName,
      lines: [],
    };
    og.lines.push(l);
    orderGroups.set(l.orderId, og);

    const custKey = l.companyId ?? '__unassigned__';
    const cg = customerGroups.get(custKey) ?? { companyName: l.companyName ?? 'No customer assigned', orderIds: new Set<string>(), lines: [] };
    cg.orderIds.add(l.orderId);
    cg.lines.push(l);
    customerGroups.set(custKey, cg);

    const monthKey = monthKeyOf(l.orderCreatedAt);
    const mg = monthGroups.get(monthKey) ?? { label: monthLabelOf(l.orderCreatedAt), lines: [] };
    mg.lines.push(l);
    monthGroups.set(monthKey, mg);
  }

  const byProduct: ProductProfitabilityRow[] = [...productGroups.entries()]
    .map(([productId, g]) => ({ productId, sku: g.sku, name: g.name, quantitySold: round2(g.quantity), summary: summarizeProfitability(g.lines) }))
    .sort((a, b) => b.summary.revenue - a.summary.revenue);

  const byOrder: SalesOrderProfitabilityRow[] = [...orderGroups.entries()]
    .map(([orderId, g]) => ({ orderId, number: g.number, status: g.status, createdAt: g.createdAt, companyId: g.companyId, companyName: g.companyName, summary: summarizeProfitability(g.lines) }))
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());

  const byCustomer: CustomerProfitabilityRow[] = [...customerGroups.entries()]
    .map(([key, g]) => ({ companyId: key === '__unassigned__' ? null : key, companyName: g.companyName, orderCount: g.orderIds.size, summary: summarizeProfitability(g.lines) }))
    .sort((a, b) => b.summary.revenue - a.summary.revenue);

  const byMonth: MonthlyProfitabilityRow[] = [...monthGroups.entries()]
    .map(([key, g]) => ({ key, label: g.label, summary: summarizeProfitability(g.lines) }))
    .sort((a, b) => a.key.localeCompare(b.key));

  return {
    filters: { from: filters.from ?? null, to: filters.to ?? null },
    overall: summarizeProfitability(lines),
    byProduct,
    byCustomer,
    byOrder,
    byMonth,
  };
}
