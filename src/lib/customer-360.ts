import { prisma } from '@/lib/prisma';
import type { Role, InvoiceStatus, Prisma } from '@prisma/client';
import { canAccess } from '@/lib/permissions';
import { toNumber } from '@/lib/format';

export class CompanyNotFoundError extends Error {
  constructor(companyId: string) {
    super(`Company ${companyId} not found`);
    this.name = 'CompanyNotFoundError';
  }
}

/**
 * Which Customer 360 sections a role may see, driven entirely by the
 * existing module-access matrix (`src/lib/permissions.ts`) — no new
 * permission concept is introduced. `companies` itself gates the whole
 * page (enforced by the caller via requireModule('companies') before this
 * is ever called), so it isn't a field here.
 */
export interface Customer360Sections {
  sales: boolean; // sales orders, opportunities, quotes, products purchased
  invoicing: boolean; // invoices, payments, financial summary
  purchasing: boolean; // purchase orders (company acting as a supplier)
  tasks: boolean;
  whatsapp: boolean;
  inbox: boolean; // email messages
}

export function getCustomer360Sections(role: Role): Customer360Sections {
  return {
    sales: canAccess(role, 'sales'),
    invoicing: canAccess(role, 'invoicing'),
    purchasing: canAccess(role, 'purchasing'),
    tasks: canAccess(role, 'tasks'),
    whatsapp: canAccess(role, 'whatsapp'),
    inbox: canAccess(role, 'inbox'),
  };
}

/** Invoice statuses that represent a real, recognized sale (excludes DRAFT
 * — not yet issued — and CANCELLED — never actually billed). */
const REVENUE_STATUSES: InvoiceStatus[] = ['SENT', 'PARTIAL', 'PAID', 'OVERDUE'];
/** Of those, the ones still carrying a balance. */
const OUTSTANDING_STATUSES: InvoiceStatus[] = ['SENT', 'PARTIAL', 'OVERDUE'];

export interface CustomerFinancialSummary {
  /** Sum of `total` across all non-draft, non-cancelled invoices. */
  totalSales: number;
  /** Sum of (total - amountPaid) across unpaid/partial/overdue invoices. */
  totalOutstanding: number;
  /** Sum of `amountPaid` across all non-draft, non-cancelled invoices. */
  totalPaid: number;
  invoiceCount: number;
}

/**
 * Computes the customer's financial summary strictly from each invoice's
 * own already-authoritative `total`/`amountPaid` fields (maintained by
 * computeTotals()/payment recording elsewhere) — never by re-summing
 * SalesOrderItem/InvoiceItem line rows independently, which would give the
 * same figure a second, potentially-drifting source of truth.
 */
export function computeCustomerFinancialSummary(
  invoices: Array<{ status: InvoiceStatus; total: unknown; amountPaid: unknown }>
): CustomerFinancialSummary {
  let totalSales = 0;
  let totalOutstanding = 0;
  let totalPaid = 0;
  let invoiceCount = 0;

  for (const invoice of invoices) {
    if (!REVENUE_STATUSES.includes(invoice.status)) continue;
    const total = toNumber(invoice.total);
    const paid = toNumber(invoice.amountPaid);
    totalSales += total;
    totalPaid += paid;
    invoiceCount += 1;
    if (OUTSTANDING_STATUSES.includes(invoice.status)) {
      totalOutstanding += total - paid;
    }
  }

  return { totalSales, totalOutstanding, totalPaid, invoiceCount };
}

export interface TopProductLine {
  productId: string;
  name: string;
  sku: string;
  totalQuantity: number;
  totalSpent: number;
}

/** Aggregates SalesOrderItem rows (excluding CANCELLED orders — never
 * actually fulfilled) into a per-product summary, sorted by amount spent.
 * Line totals use each item's own stored unitPrice/quantity/discount —
 * again, no independent re-derivation of what a line "should" have cost. */
function summarizeTopProducts(
  items: Array<{
    productId: string | null;
    quantity: unknown;
    unitPrice: unknown;
    discount: unknown;
    product: { name: string; sku: string } | null;
  }>,
  limit = 10
): TopProductLine[] {
  const byProduct = new Map<string, TopProductLine>();
  for (const item of items) {
    if (!item.productId || !item.product) continue;
    const quantity = toNumber(item.quantity);
    const lineTotal = toNumber(item.unitPrice) * quantity - toNumber(item.discount);
    const existing = byProduct.get(item.productId);
    if (existing) {
      existing.totalQuantity += quantity;
      existing.totalSpent += lineTotal;
    } else {
      byProduct.set(item.productId, {
        productId: item.productId,
        name: item.product.name,
        sku: item.product.sku,
        totalQuantity: quantity,
        totalSpent: lineTotal,
      });
    }
  }
  return [...byProduct.values()].sort((a, b) => b.totalSpent - a.totalSpent).slice(0, limit);
}

export type CustomerActivityStatus = 'active' | 'inactive' | 'no_activity';

/** Simple, documented heuristic (see docs/CUSTOMER_360.md): active if
 * something happened in the last 90 days, inactive if the last activity is
 * older than that, no_activity if there's nothing to go on at all. Only
 * considers activity the viewer is actually allowed to see (see
 * docs/CUSTOMER_360.md "Activity and authorization"). */
function computeActivity(timestamps: Array<Date | null | undefined>): {
  lastActivityAt: Date | null;
  status: CustomerActivityStatus;
} {
  const valid = timestamps.filter((t): t is Date => !!t);
  if (valid.length === 0) return { lastActivityAt: null, status: 'no_activity' };
  const lastActivityAt = new Date(Math.max(...valid.map((d) => d.getTime())));
  const daysSince = (Date.now() - lastActivityAt.getTime()) / (1000 * 60 * 60 * 24);
  return { lastActivityAt, status: daysSince <= 90 ? 'active' : 'inactive' };
}

const RECORD_LIMIT = 25;

export interface Customer360Data {
  company: NonNullable<Awaited<ReturnType<typeof fetchBaseCompany>>>;
  sections: Customer360Sections;
  sales: {
    salesOrders: Awaited<ReturnType<typeof prisma.salesOrder.findMany>>;
    quotes: Awaited<ReturnType<typeof prisma.quote.findMany>>;
    opportunities: Awaited<ReturnType<typeof prisma.opportunity.findMany>>;
    topProducts: TopProductLine[];
  } | null;
  invoicing: {
    invoices: Awaited<ReturnType<typeof prisma.invoice.findMany>>;
    payments: Array<{ id: string; amount: Prisma.Decimal; method: string; paidAt: Date; invoiceNumber: string }>;
    financialSummary: CustomerFinancialSummary;
  } | null;
  purchasing: {
    purchaseOrders: Awaited<ReturnType<typeof prisma.purchaseOrder.findMany>>;
  } | null;
  tasks: { tasks: Awaited<ReturnType<typeof prisma.task.findMany>> } | null;
  whatsapp: { messages: Awaited<ReturnType<typeof prisma.whatsAppMessage.findMany>> } | null;
  inbox: { messages: Awaited<ReturnType<typeof prisma.emailMessage.findMany>> } | null;
  activity: { lastActivityAt: Date | null; status: CustomerActivityStatus };
}

async function fetchBaseCompany(companyId: string) {
  return prisma.company.findUnique({
    where: { id: companyId },
    include: {
      phones: true,
      emails: true,
      contacts: true,
      owner: true,
      documents: { orderBy: { createdAt: 'desc' } },
      notesList: { orderBy: { createdAt: 'desc' }, include: { author: true } },
      communicationLogs: { orderBy: { occurredAt: 'desc' }, take: RECORD_LIMIT, include: { user: { select: { name: true } } } },
    },
  });
}

/**
 * Assembles the full Customer 360 view for one company, restricted to
 * exactly the sections `role` is allowed to see (per
 * `getCustomer360Sections`). Unauthorized sections aren't just hidden in
 * the UI — their queries are never issued, so the data never leaves the
 * database for a role that shouldn't see it.
 */
export async function getCustomer360(companyId: string, role: Role): Promise<Customer360Data> {
  const company = await fetchBaseCompany(companyId);
  if (!company) throw new CompanyNotFoundError(companyId);

  const sections = getCustomer360Sections(role);
  const activityTimestamps: Array<Date | null | undefined> = [
    company.notesList[0]?.createdAt,
    company.documents[0]?.createdAt,
    company.communicationLogs[0]?.occurredAt,
  ];

  let sales: Customer360Data['sales'] = null;
  if (sections.sales) {
    const [salesOrders, quotes, opportunities, items] = await Promise.all([
      prisma.salesOrder.findMany({ where: { companyId }, orderBy: { createdAt: 'desc' }, take: RECORD_LIMIT }),
      prisma.quote.findMany({ where: { companyId }, orderBy: { createdAt: 'desc' }, take: RECORD_LIMIT }),
      prisma.opportunity.findMany({ where: { companyId }, orderBy: { createdAt: 'desc' }, take: RECORD_LIMIT }),
      prisma.salesOrderItem.findMany({
        where: { salesOrder: { companyId, status: { not: 'CANCELLED' } } },
        select: { productId: true, quantity: true, unitPrice: true, discount: true, product: { select: { name: true, sku: true } } },
      }),
    ]);
    sales = { salesOrders, quotes, opportunities, topProducts: summarizeTopProducts(items) };
    activityTimestamps.push(salesOrders[0]?.createdAt, quotes[0]?.createdAt, opportunities[0]?.createdAt);
  }

  let invoicing: Customer360Data['invoicing'] = null;
  if (sections.invoicing) {
    const invoices = await prisma.invoice.findMany({
      where: { companyId },
      orderBy: { createdAt: 'desc' },
      take: RECORD_LIMIT,
    });
    const paymentsRaw = await prisma.payment.findMany({
      where: { invoice: { companyId } },
      orderBy: { paidAt: 'desc' },
      take: RECORD_LIMIT,
      include: { invoice: { select: { number: true } } },
    });
    const payments = paymentsRaw.map((p) => ({
      id: p.id,
      amount: p.amount,
      method: p.method,
      paidAt: p.paidAt,
      invoiceNumber: p.invoice.number,
    }));
    invoicing = { invoices, payments, financialSummary: computeCustomerFinancialSummary(invoices) };
    activityTimestamps.push(invoices[0]?.createdAt, payments[0]?.paidAt);
  }

  let purchasing: Customer360Data['purchasing'] = null;
  if (sections.purchasing) {
    const purchaseOrders = await prisma.purchaseOrder.findMany({
      where: { supplierId: companyId },
      orderBy: { createdAt: 'desc' },
      take: RECORD_LIMIT,
    });
    purchasing = { purchaseOrders };
    activityTimestamps.push(purchaseOrders[0]?.createdAt);
  }

  let tasksSection: Customer360Data['tasks'] = null;
  if (sections.tasks) {
    const tasks = await prisma.task.findMany({
      where: { relatedType: 'COMPANY', relatedId: companyId },
      orderBy: { createdAt: 'desc' },
      take: RECORD_LIMIT,
    });
    tasksSection = { tasks };
    activityTimestamps.push(tasks[0]?.createdAt);
  }

  let whatsapp: Customer360Data['whatsapp'] = null;
  if (sections.whatsapp) {
    const messages = await prisma.whatsAppMessage.findMany({
      where: { companyId },
      orderBy: { timestamp: 'desc' },
      take: RECORD_LIMIT,
    });
    whatsapp = { messages };
    activityTimestamps.push(messages[0]?.timestamp);
  }

  let inbox: Customer360Data['inbox'] = null;
  if (sections.inbox) {
    const messages = await prisma.emailMessage.findMany({
      where: { companyId },
      orderBy: { receivedAt: 'desc' },
      take: RECORD_LIMIT,
    });
    inbox = { messages };
    activityTimestamps.push(messages[0]?.receivedAt);
  }

  return {
    company,
    sections,
    sales,
    invoicing,
    purchasing,
    tasks: tasksSection,
    whatsapp,
    inbox,
    activity: computeActivity(activityTimestamps),
  };
}
