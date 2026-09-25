import { prisma } from '@/lib/prisma';
import type { Role } from '@prisma/client';
import { toNumber } from '@/lib/format';
import { canAccess } from '@/lib/permissions';
import { STOCK_HOLDING_STATUSES } from '@/lib/automations/stock';
import {
  getProductCostMap,
  computeLineProfitability,
  summarizeProfitability,
  type ProductCostInfo,
  type LineProfitability,
  type ProfitabilitySummary,
} from '@/lib/profitability';
import { getAccountsReceivableDashboard } from '@/lib/accounts-receivable';

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export type SalesChannelFilter = 'woocommerce' | 'direct';

export interface DashboardFilters {
  /** Scopes Gross profit/margin and the "recent" lists. Does NOT change
   * Sales today/this month/this year, which are fixed periods by
   * definition — see docs/MANAGEMENT_DASHBOARD.md. */
  from?: Date;
  to?: Date;
  companyId?: string;
  productId?: string;
  warehouseId?: string;
  /** undefined = every channel. Only "woocommerce" (synced orders,
   * externalSource = 'woocommerce') and "direct" (manually-entered
   * orders, externalSource = null) exist in this schema today — no
   * Amazon/Walmart/TikTok data exists to filter by. */
  channel?: SalesChannelFilter;
}

function channelWhere(channel?: SalesChannelFilter) {
  if (channel === 'woocommerce') return { externalSource: 'woocommerce' as const };
  if (channel === 'direct') return { externalSource: null };
  return {};
}

// =============================================================================
// Sales figures + Gross profit (one shared query)
// =============================================================================

interface RawOrderLine {
  orderId: string;
  orderCreatedAt: Date;
  companyId: string | null;
  productId: string | null;
  quantity: number;
  unitPrice: number;
  discount: number;
  description: string;
}

/** Fetches every stock-holding SalesOrder line from the start of the
 * calendar year (or the filter's own `from`, whichever is earlier — so a
 * single query covers both the fixed "this year" figure and a custom
 * date-filtered range) through now (or the filter's own `to`, if later).
 * One query for the whole dashboard's worth of sales data — every figure
 * below (today/month/year/gross profit, and their customer/product/
 * channel-filtered variants) is derived from this same in-memory list, so
 * none of them can ever disagree with each other about what "a sale" is. */
async function fetchRawOrderLines(filters: DashboardFilters): Promise<RawOrderLine[]> {
  const now = new Date();
  const yearStart = new Date(now.getFullYear(), 0, 1);
  const rangeStart = filters.from && filters.from < yearStart ? filters.from : yearStart;

  const orders = await prisma.salesOrder.findMany({
    where: {
      status: { in: [...STOCK_HOLDING_STATUSES] },
      createdAt: { gte: rangeStart },
      ...(filters.companyId ? { companyId: filters.companyId } : {}),
      ...channelWhere(filters.channel),
    },
    select: {
      id: true,
      createdAt: true,
      companyId: true,
      items: {
        select: { productId: true, quantity: true, unitPrice: true, discount: true, description: true },
      },
    },
  });

  const lines: RawOrderLine[] = [];
  for (const o of orders) {
    for (const item of o.items) {
      if (filters.productId && item.productId !== filters.productId) continue;
      lines.push({
        orderId: o.id,
        orderCreatedAt: o.createdAt,
        companyId: o.companyId,
        productId: item.productId,
        quantity: toNumber(item.quantity),
        unitPrice: toNumber(item.unitPrice),
        discount: toNumber(item.discount),
        description: item.description,
      });
    }
  }
  return lines;
}

/** Sum of `quantity * unitPrice - discount` (pre-tax net revenue, the same
 * definition used throughout — see docs/PROFITABILITY_REPORTING.md) across
 * every line whose order falls in `[gte, lt)`. Deliberately does not need
 * a product cost map: revenue never depends on cost, so this is safe to
 * compute for every role regardless of finance access. */
function sumRevenue(lines: RawOrderLine[], gte: Date, lt?: Date): number {
  let total = 0;
  for (const l of lines) {
    if (l.orderCreatedAt < gte) continue;
    if (lt && l.orderCreatedAt >= lt) continue;
    total += l.quantity * l.unitPrice - l.discount;
  }
  return round2(total);
}

export interface SalesFigures {
  today: number;
  thisMonth: number;
  thisYear: number;
}

function computeSalesFigures(lines: RawOrderLine[], now: Date): SalesFigures {
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const yearStart = new Date(now.getFullYear(), 0, 1);
  return {
    today: sumRevenue(lines, todayStart),
    thisMonth: sumRevenue(lines, monthStart),
    thisYear: sumRevenue(lines, yearStart),
  };
}

/** Gross profit/margin for the custom filtered date range (defaults to
 * everything from the start of the year if no `from` is given). Only
 * meaningful — and only ever called — for roles with `finance` access;
 * see `getDashboardData`. */
function computeGrossProfitForRange(
  lines: RawOrderLine[],
  costMap: Map<string, ProductCostInfo>,
  filters: DashboardFilters
): ProfitabilitySummary {
  const scored: LineProfitability[] = lines
    .filter((l) => (!filters.from || l.orderCreatedAt >= filters.from) && (!filters.to || l.orderCreatedAt <= filters.to))
    .map((l) =>
      computeLineProfitability(
        { productId: l.productId, quantity: l.quantity, unitPrice: l.unitPrice, discount: l.discount, description: l.description },
        costMap
      )
    );
  return summarizeProfitability(scored);
}

// =============================================================================
// Inventory value + low stock (one shared query)
// =============================================================================

export interface InventoryValueSummary {
  /** Sum of quantity * resolved unit cost across every tracked-inventory
   * stock level whose product has a resolvable cost. Never includes a
   * guessed cost for a product with none — see `hasUnknownCost`. */
  knownValue: number;
  hasUnknownCost: boolean;
  /** How many on-hand units belong to a product with no resolvable cost —
   * lets the UI say "$X known + Y units of unknown value" instead of
   * silently under-reporting total inventory value as just $X. */
  unknownCostUnits: number;
  unknownCostProductCount: number;
}

export interface LowStockItem {
  productId: string;
  sku: string;
  name: string;
  warehouseName: string;
  quantity: number;
  reorderPoint: number;
}

async function loadInventorySnapshot(
  filters: DashboardFilters,
  costMap: Map<string, ProductCostInfo> | null
): Promise<{ inventoryValue: InventoryValueSummary | null; lowStock: LowStockItem[] }> {
  const levels = await prisma.stockLevel.findMany({
    where: {
      ...(filters.warehouseId ? { warehouseId: filters.warehouseId } : {}),
      ...(filters.productId ? { productVariant: { productId: filters.productId } } : {}),
    },
    select: {
      quantity: true,
      productVariant: {
        select: {
          productId: true,
          product: { select: { sku: true, name: true, reorderPoint: true, trackInventory: true } },
        },
      },
      warehouse: { select: { name: true } },
    },
  });

  let knownValue = 0;
  let unknownCostUnits = 0;
  const unknownCostProductIds = new Set<string>();
  const lowStock: LowStockItem[] = [];

  for (const level of levels) {
    const product = level.productVariant.product;
    if (!product.trackInventory) continue;

    if (costMap) {
      const cost = costMap.get(level.productVariant.productId);
      if (cost && cost.unitCost !== null) {
        knownValue += level.quantity * cost.unitCost;
      } else if (level.quantity > 0) {
        unknownCostUnits += level.quantity;
        unknownCostProductIds.add(level.productVariant.productId);
      }
    }

    if (level.quantity <= product.reorderPoint) {
      lowStock.push({
        productId: level.productVariant.productId,
        sku: product.sku,
        name: product.name,
        warehouseName: level.warehouse.name,
        quantity: level.quantity,
        reorderPoint: product.reorderPoint,
      });
    }
  }

  lowStock.sort((a, b) => a.quantity - a.reorderPoint - (b.quantity - b.reorderPoint));

  return {
    inventoryValue: costMap
      ? {
          knownValue: round2(knownValue),
          hasUnknownCost: unknownCostProductIds.size > 0,
          unknownCostUnits,
          unknownCostProductCount: unknownCostProductIds.size,
        }
      : null,
    lowStock,
  };
}

// =============================================================================
// Open documents (quotes / sales orders / purchase orders)
// =============================================================================

export interface OpenDocumentsSummary {
  quotes: { count: number; total: number };
  salesOrders: { count: number; total: number };
  purchaseOrders: { count: number; total: number };
}

async function loadOpenDocuments(filters: DashboardFilters): Promise<OpenDocumentsSummary> {
  const [quotes, salesOrders, purchaseOrders] = await Promise.all([
    prisma.quote.aggregate({
      where: { status: { in: ['DRAFT', 'SENT'] }, ...(filters.companyId ? { companyId: filters.companyId } : {}) },
      _count: true,
      _sum: { total: true },
    }),
    prisma.salesOrder.aggregate({
      where: {
        status: { in: ['DRAFT', 'CONFIRMED', 'SHIPPED'] },
        ...(filters.companyId ? { companyId: filters.companyId } : {}),
        ...channelWhere(filters.channel),
      },
      _count: true,
      _sum: { total: true },
    }),
    // Purchase orders are supplier-side — the customer/product/warehouse/
    // channel filters (all sales-side concepts) don't apply here; see
    // docs/MANAGEMENT_DASHBOARD.md "Which filters apply where."
    prisma.purchaseOrder.aggregate({
      where: { status: { in: ['DRAFT', 'SENT', 'PARTIALLY_RECEIVED'] } },
      _count: true,
      _sum: { total: true },
    }),
  ]);

  return {
    quotes: { count: quotes._count, total: toNumber(quotes._sum.total) },
    salesOrders: { count: salesOrders._count, total: toNumber(salesOrders._sum.total) },
    purchaseOrders: { count: purchaseOrders._count, total: toNumber(purchaseOrders._sum.total) },
  };
}

// =============================================================================
// Recent activity
// =============================================================================

export interface RecentOrderRow {
  id: string;
  number: string;
  companyName: string | null;
  status: string;
  total: number;
  createdAt: Date;
  channel: 'woocommerce' | 'direct';
}

export interface RecentPaymentRow {
  id: string;
  invoiceNumber: string;
  companyName: string | null;
  amount: number;
  method: string;
  paidAt: Date;
}

export interface RecentMovementRow {
  id: string;
  productName: string;
  sku: string;
  variantName: string;
  warehouseName: string;
  type: string;
  quantity: number;
  reason: string | null;
  /** What caused this movement (e.g. a SalesOrder shipment, a
   * GoodsReceipt, a manual adjustment) — StockMovement's own
   * `referenceType`/`referenceId`, shown as-is rather than resolved to a
   * link, since the referenced record's type varies. */
  referenceType: string | null;
  referenceId: string | null;
  createdAt: Date;
}

const RECENT_LIMIT = 10;

async function loadRecentActivity(filters: DashboardFilters): Promise<{
  orders: RecentOrderRow[];
  payments: RecentPaymentRow[];
  movements: RecentMovementRow[];
}> {
  const dateRange =
    filters.from || filters.to ? { ...(filters.from ? { gte: filters.from } : {}), ...(filters.to ? { lte: filters.to } : {}) } : undefined;

  const [orders, payments, movements] = await Promise.all([
    prisma.salesOrder.findMany({
      where: {
        ...(filters.companyId ? { companyId: filters.companyId } : {}),
        ...channelWhere(filters.channel),
        ...(dateRange ? { createdAt: dateRange } : {}),
      },
      select: { id: true, number: true, status: true, total: true, createdAt: true, externalSource: true, company: { select: { name: true } } },
      orderBy: { createdAt: 'desc' },
      take: RECENT_LIMIT,
    }),
    prisma.payment.findMany({
      where: {
        ...(filters.companyId ? { invoice: { companyId: filters.companyId } } : {}),
        ...(dateRange ? { paidAt: dateRange } : {}),
      },
      select: {
        id: true,
        amount: true,
        method: true,
        paidAt: true,
        invoice: { select: { number: true, company: { select: { name: true } } } },
      },
      orderBy: { paidAt: 'desc' },
      take: RECENT_LIMIT,
    }),
    prisma.stockMovement.findMany({
      where: {
        ...(filters.warehouseId ? { warehouseId: filters.warehouseId } : {}),
        ...(filters.productId ? { productVariant: { productId: filters.productId } } : {}),
        ...(dateRange ? { createdAt: dateRange } : {}),
      },
      select: {
        id: true,
        type: true,
        quantity: true,
        reason: true,
        referenceType: true,
        referenceId: true,
        createdAt: true,
        productVariant: { select: { name: true, product: { select: { name: true, sku: true } } } },
        warehouse: { select: { name: true } },
      },
      orderBy: { createdAt: 'desc' },
      take: RECENT_LIMIT,
    }),
  ]);

  return {
    orders: orders.map((o) => ({
      id: o.id,
      number: o.number,
      companyName: o.company?.name ?? null,
      status: o.status,
      total: toNumber(o.total),
      createdAt: o.createdAt,
      channel: o.externalSource === 'woocommerce' ? 'woocommerce' : 'direct',
    })),
    payments: payments.map((p) => ({
      id: p.id,
      invoiceNumber: p.invoice.number,
      companyName: p.invoice.company?.name ?? null,
      amount: toNumber(p.amount),
      method: p.method,
      paidAt: p.paidAt,
    })),
    movements: movements.map((m) => ({
      id: m.id,
      productName: m.productVariant.product.name,
      sku: m.productVariant.product.sku,
      variantName: m.productVariant.name,
      warehouseName: m.warehouse.name,
      type: m.type,
      quantity: m.quantity,
      reason: m.reason,
      referenceType: m.referenceType,
      referenceId: m.referenceId,
      createdAt: m.createdAt,
    })),
  };
}

// =============================================================================
// Filter option lists (for the dropdowns)
// =============================================================================

export interface DashboardFilterOptions {
  customers: Array<{ id: string; name: string }>;
  products: Array<{ id: string; sku: string; name: string }>;
  warehouses: Array<{ id: string; name: string }>;
}

export async function getDashboardFilterOptions(): Promise<DashboardFilterOptions> {
  const [customers, products, warehouses] = await Promise.all([
    prisma.company.findMany({
      where: { type: { in: ['CUSTOMER', 'BOTH'] }, active: true },
      select: { id: true, name: true },
      orderBy: { name: 'asc' },
      take: 500,
    }),
    prisma.product.findMany({
      where: { active: true },
      select: { id: true, sku: true, name: true },
      orderBy: { name: 'asc' },
      take: 500,
    }),
    prisma.warehouse.findMany({
      where: { active: true },
      select: { id: true, name: true },
      orderBy: { name: 'asc' },
    }),
  ]);
  return { customers, products, warehouses };
}

// =============================================================================
// The dashboard, assembled
// =============================================================================

export interface DashboardData {
  filters: DashboardFilters;
  generatedAt: Date;
  sales: SalesFigures;
  receivables: { outstanding: { total: number; count: number }; overdue: { total: number; count: number } };
  /** null for a role without `finance` module access — see
   * docs/MANAGEMENT_DASHBOARD.md "Role-based visibility". */
  grossProfit: ProfitabilitySummary | null;
  inventoryValue: InventoryValueSummary | null;
  lowStock: LowStockItem[];
  open: OpenDocumentsSummary;
  recent: {
    orders: RecentOrderRow[];
    payments: RecentPaymentRow[];
    movements: RecentMovementRow[];
  };
}

/**
 * Assembles the whole management dashboard for one role + filter set.
 * Every figure traces back to a real, current database record — nothing
 * here is estimated, interpolated, or hard-coded. Independent sections run
 * concurrently (`Promise.all`); the sales/gross-profit section shares one
 * query (`fetchRawOrderLines`) and the inventory section shares one
 * product-cost-map fetch, so nothing is queried twice. See
 * docs/MANAGEMENT_DASHBOARD.md for the exact definition of every figure and which
 * filters apply to which section.
 */
export async function getDashboardData(role: Role, filters: DashboardFilters): Promise<DashboardData> {
  const now = new Date();
  const hasFinanceAccess = canAccess(role, 'finance');

  const [rawLines, costMap, receivablesDashboard, openDocs, recent] = await Promise.all([
    fetchRawOrderLines(filters),
    hasFinanceAccess ? getProductCostMap() : Promise.resolve(null),
    getAccountsReceivableDashboard(now, filters.companyId),
    loadOpenDocuments(filters),
    loadRecentActivity(filters),
  ]);

  const sales = computeSalesFigures(rawLines, now);
  const grossProfit = hasFinanceAccess && costMap ? computeGrossProfitForRange(rawLines, costMap, filters) : null;
  const { inventoryValue, lowStock } = await loadInventorySnapshot(filters, costMap);

  return {
    filters,
    generatedAt: now,
    sales,
    receivables: {
      outstanding: { total: receivablesDashboard.summary.totalOutstanding, count: receivablesDashboard.summary.totalOutstandingCount },
      overdue: { total: receivablesDashboard.summary.overdue, count: receivablesDashboard.summary.overdueCount },
    },
    grossProfit,
    inventoryValue,
    lowStock,
    open: openDocs,
    recent,
  };
}
