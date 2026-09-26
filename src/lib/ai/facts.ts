import { prisma } from '@/lib/prisma';
import type { Role, RelatedEntityType } from '@prisma/client';
import { getCustomer360, CompanyNotFoundError, type Customer360Data } from '@/lib/customer-360';
import { getDashboardData } from '@/lib/dashboard';
import { getAccountsReceivableDashboard } from '@/lib/accounts-receivable';
import { getProductProfitability } from '@/lib/profitability';
import { money, formatDate, toNumber } from '@/lib/format';

export { CompanyNotFoundError };

/**
 * Deterministic, code-computed FACTS builders — one per AI feature
 * (docs/AI_FEATURES.md "Grounding"). Every function here reads only from
 * the database (reusing the same already-authoritative aggregation
 * functions every other part of the app uses — getCustomer360,
 * getDashboardData, getAccountsReceivableDashboard,
 * getProductProfitability — never re-deriving totals independently) and
 * returns plain strings. These strings are NEVER generated or altered by
 * the LLM; they are the grounding the LLM's summary/recommendations must
 * stay consistent with, and they're also what a caller displays directly
 * if the AI layer is unavailable. This is also why the "no prior contact"
 * guardrail is enforced here, in code, rather than left to the model to
 * get right.
 */

// =============================================================================
// Customer Summary
// =============================================================================

export async function buildCustomerSummaryFacts(companyId: string, role: Role): Promise<{ facts: string[]; data: Customer360Data }> {
  const data = await getCustomer360(companyId, role);
  const facts: string[] = [`Company: ${data.company.name} (${data.company.type}).`];

  const comms = data.company.communicationLogs;
  if (comms.length === 0) {
    facts.push('No prior contact found — no communication log entries exist for this company.');
  } else {
    const last = comms[0];
    facts.push(
      `Last contact: ${last.type} (${last.direction}) on ${formatDate(last.occurredAt)}${last.subject ? ` — "${last.subject}"` : ''}.`
    );
    facts.push(`Total logged communications: ${comms.length}.`);
  }

  if (data.sales) {
    const openQuotes = data.sales.quotes.filter((q) => q.status === 'SENT' || q.status === 'DRAFT');
    facts.push(`Open quotes: ${openQuotes.length}.`);
    facts.push(`Sales orders on file: ${data.sales.salesOrders.length}.`);
    if (data.sales.topProducts.length > 0) {
      const top = data.sales.topProducts[0];
      facts.push(`Top purchased product: ${top.name} (${top.totalQuantity} units, ${money(top.totalSpent)}).`);
    }
  }

  if (data.invoicing) {
    const fs = data.invoicing.financialSummary;
    facts.push(`Total invoiced: ${money(fs.totalSales)} across ${fs.invoiceCount} invoice(s).`);
    facts.push(`Outstanding balance: ${money(fs.totalOutstanding)}.`);
    facts.push(`Total paid to date: ${money(fs.totalPaid)}.`);
  }

  if (data.tasks) {
    const open = data.tasks.tasks.filter((t) => t.status === 'TODO' || t.status === 'IN_PROGRESS');
    facts.push(
      open.length === 0
        ? 'No open tasks for this account.'
        : `Open tasks: ${open.length} (e.g. "${open[0].title}"${open[0].dueDate ? ` due ${formatDate(open[0].dueDate)}` : ''}).`
    );
  }

  facts.push(
    `Account activity status: ${data.activity.status}${
      data.activity.lastActivityAt ? ` (last activity ${formatDate(data.activity.lastActivityAt)})` : ' (no recorded activity)'
    }.`
  );

  return { facts, data };
}

// =============================================================================
// Sales Summary
// =============================================================================

export async function buildSalesSummaryFacts(role: Role): Promise<string[]> {
  const data = await getDashboardData(role, {});
  const facts: string[] = [];

  facts.push(`Sales today: ${money(data.sales.today)}. This month: ${money(data.sales.thisMonth)}. This year: ${money(data.sales.thisYear)}.`);
  facts.push(
    `Accounts receivable outstanding: ${money(data.receivables.outstanding.total)} across ${data.receivables.outstanding.count} invoice(s); ${money(
      data.receivables.overdue.total
    )} of that is overdue (${data.receivables.overdue.count} invoice(s)).`
  );

  if (data.grossProfit) {
    const gp = data.grossProfit;
    const profitText = gp.grossProfit !== null ? money(gp.grossProfit) : `at least ${money(gp.partialGrossProfit)} (some product costs unknown)`;
    facts.push(`Gross profit (year to date): ${profitText}${gp.grossMarginPercent !== null ? `, margin ${gp.grossMarginPercent}%` : ''}.`);
  }

  facts.push(`Open quotes: ${data.open.quotes.count} totaling ${money(data.open.quotes.total)}.`);
  facts.push(`Open sales orders: ${data.open.salesOrders.count} totaling ${money(data.open.salesOrders.total)}.`);
  facts.push(`Open purchase orders: ${data.open.purchaseOrders.count} totaling ${money(data.open.purchaseOrders.total)}.`);
  facts.push(
    data.lowStock.length === 0
      ? 'No products are currently at or below their reorder point.'
      : `${data.lowStock.length} product(s) are currently at or below their reorder point.`
  );

  return facts;
}

// =============================================================================
// Product Sales Analysis
// =============================================================================

export async function buildProductAnalysisFacts(productId: string): Promise<string[]> {
  const product = await prisma.product.findUnique({ where: { id: productId } });
  if (!product) throw new Error('Product not found');

  const now = new Date();
  const DAY = 86_400_000;
  const recentFrom = new Date(now.getTime() - 30 * DAY);
  const priorFrom = new Date(now.getTime() - 60 * DAY);

  const [recentRows, priorRows, stockLevels] = await Promise.all([
    getProductProfitability({ from: recentFrom, to: now }),
    getProductProfitability({ from: priorFrom, to: recentFrom }),
    prisma.stockLevel.findMany({ where: { productVariant: { productId } }, include: { warehouse: true } }),
  ]);

  const recent = recentRows.find((r) => r.productId === productId);
  const prior = priorRows.find((r) => r.productId === productId);
  const totalStock = stockLevels.reduce((s, l) => s + l.quantity, 0);
  const recentQty = recent?.quantitySold ?? 0;
  const priorQty = prior?.quantitySold ?? 0;

  const facts: string[] = [`Product: ${product.name} (SKU ${product.sku}).`];
  facts.push(`Reorder point: ${product.reorderPoint} units.`);
  facts.push(`Current stock on hand: ${totalStock} unit(s) across ${stockLevels.length} warehouse location(s).`);
  facts.push(`Units sold in the last 30 days: ${recentQty} (${money(recent?.summary.revenue ?? 0)} revenue).`);
  facts.push(`Units sold in the prior 30 days (30-60 days ago): ${priorQty} (${money(prior?.summary.revenue ?? 0)} revenue).`);

  if (priorQty === 0 && recentQty === 0) {
    facts.push('No sales recorded for this product in the last 60 days.');
  } else if (priorQty === 0) {
    facts.push('Demand trend: new or resumed demand — no sales recorded in the prior 30-day period.');
  } else {
    const change = Math.round(((recentQty - priorQty) / priorQty) * 100);
    facts.push(`Demand trend: ${change >= 0 ? 'up' : 'down'} ${Math.abs(change)}% versus the prior 30-day period.`);
  }

  if (!product.trackInventory) {
    facts.push('Inventory is not tracked for this product.');
  } else if (recentQty > 0) {
    const dailyRate = recentQty / 30;
    const daysRemaining = Math.round(totalStock / dailyRate);
    facts.push(`Estimated days of stock remaining at the current sell-through rate: ${daysRemaining}.`);
  } else {
    facts.push('Not enough recent sales activity to estimate reorder velocity.');
  }

  return facts;
}

// =============================================================================
// Inventory Warning Explanation
// =============================================================================

export async function buildInventoryWarningFacts(productVariantId: string, warehouseId: string): Promise<string[]> {
  const level = await prisma.stockLevel.findUnique({
    where: { productVariantId_warehouseId: { productVariantId, warehouseId } },
    include: { productVariant: { include: { product: true } }, warehouse: true },
  });
  if (!level) throw new Error('Stock level not found');

  const product = level.productVariant.product;
  const facts: string[] = [`Product: ${product.name} (SKU ${product.sku}) at warehouse ${level.warehouse.name}.`];
  facts.push(`Current quantity on hand: ${level.quantity}.`);
  facts.push(`Reorder point: ${product.reorderPoint}.`);

  if (level.quantity > product.reorderPoint) {
    facts.push('Stock is currently above the reorder point — there is no active low-stock warning for this location.');
    return facts;
  }

  facts.push(`Shortfall: ${product.reorderPoint - level.quantity} unit(s) below the reorder point.`);

  const openItems = await prisma.salesOrderItem.findMany({
    where: { productId: product.id, salesOrder: { status: 'CONFIRMED' } },
    include: { salesOrder: { select: { number: true } } },
  });

  if (openItems.length === 0) {
    facts.push('No open (confirmed, not yet shipped) sales orders currently require this product.');
  } else {
    const orderNumbers = [...new Set(openItems.map((i) => i.salesOrder.number))];
    const totalQtyNeeded = openItems.reduce((s, i) => s + toNumber(i.quantity), 0);
    facts.push(
      `Open confirmed sales orders requiring this product: ${orderNumbers.length} (${orderNumbers.slice(0, 5).join(', ')}${
        orderNumbers.length > 5 ? ', ...' : ''
      }), totaling ${totalQtyNeeded} unit(s) needed.`
    );
  }

  return facts;
}

// =============================================================================
// Customer Follow-Up Suggestions
// =============================================================================

/** A SENT quote with no explicit expiry is treated as "inactive" once it's
 * older than this — see docs/AI_FEATURES.md "Follow-up thresholds". */
export const STALE_QUOTE_DAYS = 14;

export async function buildFollowUpFacts(companyId: string): Promise<string[]> {
  const company = await prisma.company.findUnique({ where: { id: companyId }, select: { id: true, name: true } });
  if (!company) throw new Error('Company not found');

  const now = new Date();
  const staleThreshold = new Date(now.getTime() - STALE_QUOTE_DAYS * 86_400_000);

  const [quotes, ar, tasks] = await Promise.all([
    prisma.quote.findMany({ where: { companyId, status: 'SENT' }, orderBy: { createdAt: 'desc' } }),
    getAccountsReceivableDashboard(now, companyId),
    prisma.task.findMany({
      where: { relatedType: 'COMPANY', relatedId: companyId, status: { in: ['TODO', 'IN_PROGRESS'] } },
      orderBy: { dueDate: 'asc' },
    }),
  ]);

  const staleQuotes = quotes.filter((q) => (q.validUntil ? q.validUntil < now : q.createdAt < staleThreshold));

  const facts: string[] = [`Company: ${company.name}.`];

  facts.push(
    staleQuotes.length === 0
      ? 'No inactive (sent, unresponded) quotes found.'
      : `Inactive quotes: ${staleQuotes.length}, e.g. #${staleQuotes[0].number} (${money(toNumber(staleQuotes[0].total))}, sent ${formatDate(
          staleQuotes[0].createdAt
        )}).`
  );

  facts.push(
    ar.aging.count === 0
      ? 'No overdue invoices for this account.'
      : `Overdue invoices: ${ar.aging.count} totaling ${money(ar.aging.total)} (0-30 days: ${money(ar.aging.d0to30)}, 31-60 days: ${money(
          ar.aging.d31to60
        )}, 61-90 days: ${money(ar.aging.d61to90)}, 90+ days: ${money(ar.aging.d90plus)}).`
  );

  facts.push(
    tasks.length === 0
      ? 'No pending tasks for this account.'
      : `Pending tasks: ${tasks.length}, e.g. "${tasks[0].title}"${tasks[0].dueDate ? ` (due ${formatDate(tasks[0].dueDate)})` : ' (no due date)'}.`
  );

  return facts;
}

// =============================================================================
// Invoice / Account Summary
// =============================================================================

export async function buildInvoiceAccountSummaryFacts(companyId: string): Promise<string[]> {
  const company = await prisma.company.findUnique({ where: { id: companyId }, select: { id: true, name: true } });
  if (!company) throw new Error('Company not found');

  const now = new Date();
  const [ar, recentPayments] = await Promise.all([
    getAccountsReceivableDashboard(now, companyId),
    prisma.payment.findMany({
      where: { invoice: { companyId } },
      orderBy: { paidAt: 'desc' },
      take: 5,
      include: { invoice: { select: { number: true } } },
    }),
  ]);

  const facts: string[] = [`Account: ${company.name}.`];
  facts.push(`Total outstanding balance: ${money(ar.summary.totalOutstanding)} across ${ar.summary.totalOutstandingCount} open invoice(s).`);
  facts.push(`Current (not yet due): ${money(ar.summary.current)} (${ar.summary.currentCount}). Overdue: ${money(ar.summary.overdue)} (${ar.summary.overdueCount}).`);
  facts.push(
    `Aging breakdown of overdue balance — 0-30 days: ${money(ar.aging.d0to30)}, 31-60 days: ${money(ar.aging.d31to60)}, 61-90 days: ${money(
      ar.aging.d61to90
    )}, 90+ days: ${money(ar.aging.d90plus)}.`
  );
  facts.push(`Paid in full to date: ${money(ar.summary.paid)} across ${ar.summary.paidCount} invoice(s).`);

  if (recentPayments.length === 0) {
    facts.push('No payments recorded for this account.');
  } else {
    facts.push(
      `Recent payments: ${recentPayments
        .map((p) => `${money(toNumber(p.amount))} on ${formatDate(p.paidAt)} (invoice ${p.invoice.number}, ${p.method})`)
        .join('; ')}.`
    );
  }

  return facts;
}

// =============================================================================
// Email Draft Assistant
// =============================================================================

export interface EmailDraftContext {
  companyId: string;
  contactId?: string | null;
  relatedType?: RelatedEntityType | null;
  relatedId?: string | null;
}

async function describeRelatedRecord(relatedType: RelatedEntityType, relatedId: string): Promise<string | null> {
  switch (relatedType) {
    case 'QUOTE': {
      const q = await prisma.quote.findUnique({ where: { id: relatedId } });
      return q
        ? `Related quote: #${q.number}, status ${q.status}, total ${money(toNumber(q.total))}${q.validUntil ? `, valid until ${formatDate(q.validUntil)}` : ''}.`
        : null;
    }
    case 'SALES_ORDER': {
      const o = await prisma.salesOrder.findUnique({ where: { id: relatedId } });
      return o ? `Related sales order: #${o.number}, status ${o.status}, total ${money(toNumber(o.total))}.` : null;
    }
    case 'INVOICE': {
      const i = await prisma.invoice.findUnique({ where: { id: relatedId } });
      return i
        ? `Related invoice: #${i.number}, status ${i.status}, total ${money(toNumber(i.total))}, balance due ${money(
            toNumber(i.total) - toNumber(i.amountPaid)
          )}.`
        : null;
    }
    default:
      return null;
  }
}

export async function buildEmailDraftFacts(ctx: EmailDraftContext): Promise<{ facts: string[]; recipientEmail: string | null }> {
  const company = await prisma.company.findUnique({
    where: { id: ctx.companyId },
    include: { emails: true, contacts: true },
  });
  if (!company) throw new Error('Company not found');

  const contact = ctx.contactId ? company.contacts.find((c) => c.id === ctx.contactId) ?? null : company.contacts[0] ?? null;
  const recipientEmail = contact?.email || company.emails[0]?.address || null;

  const facts: string[] = [`Recipient company: ${company.name}.`];
  facts.push(
    contact
      ? `Recipient contact: ${contact.firstName} ${contact.lastName}${contact.email ? ` (${contact.email})` : ''}.`
      : 'No specific contact on file — addressing the company generally.'
  );

  const recentComms = await prisma.communicationLog.findMany({
    where: { companyId: ctx.companyId },
    orderBy: { occurredAt: 'desc' },
    take: 3,
  });
  if (recentComms.length === 0) {
    facts.push('No prior contact found — no communication log entries exist for this company.');
  } else {
    facts.push(
      `Most recent contact: ${recentComms[0].type} (${recentComms[0].direction}) on ${formatDate(recentComms[0].occurredAt)}${
        recentComms[0].subject ? ` — "${recentComms[0].subject}"` : ''
      }.`
    );
  }

  if (ctx.relatedType && ctx.relatedId) {
    const relatedFact = await describeRelatedRecord(ctx.relatedType, ctx.relatedId);
    if (relatedFact) facts.push(relatedFact);
  }

  return { facts, recipientEmail };
}
