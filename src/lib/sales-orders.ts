import { prisma } from '@/lib/prisma';
import type { Prisma, Invoice, InvoiceItem, SalesOrder, SalesOrderStatus } from '@prisma/client';
import {
  applySalesOrderInventoryEffect,
  applySalesOrderLineMovements,
  extractTrackedLines,
  hasDeductedStock,
  STOCK_HOLDING_STATUSES,
  type TrackedOrderLine,
} from '@/lib/automations/stock';
import { generateNumber } from '@/lib/numbering';

const orderItemsInclude = {
  items: { include: { productVariant: { include: { product: true } } } },
} satisfies Prisma.SalesOrderInclude;

function linesEqual(a: TrackedOrderLine[], b: TrackedOrderLine[]): boolean {
  const normalize = (lines: TrackedOrderLine[]) => {
    const totals = new Map<string, number>();
    for (const line of lines) {
      totals.set(line.productVariantId, (totals.get(line.productVariantId) ?? 0) + line.quantity);
    }
    return [...totals.entries()].sort(([a], [b]) => a.localeCompare(b));
  };
  const na = normalize(a);
  const nb = normalize(b);
  if (na.length !== nb.length) return false;
  return na.every(([variantId, qty], i) => nb[i][0] === variantId && nb[i][1] === qty);
}

/** Thrown when a status change loses a race: another request already moved
 * the order away from the status we last read. The caller should surface
 * this as a 409 and let the user reload and retry — not silently reapply
 * anything. */
export class SalesOrderStatusConflictError extends Error {
  constructor(public readonly orderId: string) {
    super('This order was just changed by someone else. Reload the page and try again.');
    this.name = 'SalesOrderStatusConflictError';
  }
}

export interface SalesOrderStatusTransitionResult {
  order: SalesOrder;
  previousStatus: SalesOrderStatus;
  /** False when the requested status was already the current one (a
   * harmless resend/retry) — no inventory effect was applied. */
  changed: boolean;
}

/**
 * Atomically moves a sales order to a new status and applies the matching
 * inventory effect exactly once. This is the fix for a real race: two
 * concurrent requests (a double-click, a timed-out request that gets
 * retried, two staff members acting on the same order) that both read the
 * order's current status before either had written could previously both
 * pass the "did this already happen?" check and both deduct/return stock.
 *
 * The whole thing — the status change and the inventory effect — runs in a
 * single database transaction, and the status change itself is a
 * conditional `UPDATE ... WHERE id = ? AND status = ?`. Postgres guarantees
 * that update is atomic: if a concurrent transaction already moved the row
 * away from the status this call last read, the UPDATE matches zero rows
 * and we throw SalesOrderStatusConflictError instead of proceeding — so at
 * most one of two racing requests can ever apply the inventory effect for
 * the same transition.
 */
export async function transitionSalesOrderStatus(
  orderId: string,
  targetStatus: SalesOrderStatus
): Promise<SalesOrderStatusTransitionResult> {
  return prisma.$transaction(async (tx) => {
    const current = await tx.salesOrder.findUniqueOrThrow({ where: { id: orderId } });

    if (current.status === targetStatus) {
      // Resending the same status (e.g. a retried request whose first
      // attempt actually already succeeded) is a harmless no-op.
      return { order: current, previousStatus: current.status, changed: false };
    }

    const result = await tx.salesOrder.updateMany({
      where: { id: orderId, status: current.status },
      data: { status: targetStatus },
    });

    if (result.count === 0) {
      throw new SalesOrderStatusConflictError(orderId);
    }

    if (targetStatus === 'CONFIRMED' || targetStatus === 'SHIPPED') {
      await applySalesOrderInventoryEffect(orderId, targetStatus, tx);
    } else if (targetStatus === 'CANCELLED') {
      await applySalesOrderInventoryEffect(orderId, 'CANCELLED', tx);
    }

    const order = await tx.salesOrder.findUniqueOrThrow({ where: { id: orderId } });
    return { order, previousStatus: current.status, changed: true };
  });
}

export interface SalesOrderItemInput {
  productId?: string | null;
  productVariantId?: string | null;
  description: string;
  quantity: number;
  unitPrice: number;
  taxRate: number;
  discount: number;
}

export interface SalesOrderWriteInput {
  companyId?: string | null;
  contactId?: string | null;
  quoteId?: string | null;
  status: SalesOrderStatus;
  notes?: string | null;
  items: SalesOrderItemInput[];
}

export interface SalesOrderTotals {
  subtotal: number;
  taxTotal: number;
  discountTotal: number;
  total: number;
}

/**
 * Creates a new sales order and, if it's created directly in a
 * stock-holding status (CONFIRMED, SHIPPED, or — unusually — DELIVERED,
 * rather than the normal DRAFT default), deducts inventory for it in the
 * same transaction. Without this, a sales order created with a non-DRAFT
 * initial status (the create form's status field allows this) would never
 * have its inventory effect applied at all, since creation never went
 * through transitionSalesOrderStatus. See docs/INVENTORY_RULES.md.
 */
export async function createSalesOrderWithInventoryEffect(
  input: SalesOrderWriteInput,
  totals: SalesOrderTotals,
  number: string
): Promise<SalesOrder> {
  return prisma.$transaction(async (tx) => {
    const { items, ...rest } = input;
    const order = await tx.salesOrder.create({
      data: { ...rest, number, ...totals, items: { create: items } },
    });

    if (STOCK_HOLDING_STATUSES.has(order.status)) {
      const created = await tx.salesOrder.findUniqueOrThrow({
        where: { id: order.id },
        include: orderItemsInclude,
      });
      const lines = extractTrackedLines(created.items);
      await applySalesOrderLineMovements(lines, 'OUT', {
        salesOrderId: order.id,
        reason: `Sales order ${order.number} created directly as ${order.status.toLowerCase()}`,
        db: tx,
      });
    }

    return order;
  });
}

/**
 * Updates a sales order's fields/items/status and reconciles inventory so
 * the StockMovement ledger always matches what the order currently says —
 * closing the gap where editing a CONFIRMED/SHIPPED order's quantities (or
 * changing its status via this same route, which the edit form allows)
 * left stock history permanently out of sync with the order (SYSTEM_AUDIT.md
 * D2).
 *
 * Concurrency: a Postgres advisory transaction lock keyed by the order id
 * (the same pattern used by createInvoiceForSalesOrder) serializes
 * concurrent edits/transitions for the *same* order, so two racing
 * requests can't both read the "before" snapshot before either has
 * written — the second waits, then reconciles against the first's result.
 *
 * Reconciliation rule: if the order currently holds a net stock deduction
 * (hasDeductedStock) and either the tracked item lines or the status are
 * changing, first reverse exactly the previous lines (an IN for each), then
 * — if the order's new status is stock-holding (CONFIRMED/SHIPPED/DELIVERED)
 * — deduct the new lines (an OUT for each). If nothing that affects
 * inventory actually changed, no movement is created at all, so resending
 * an identical edit is a no-op. See docs/INVENTORY_RULES.md.
 */
export async function updateSalesOrderWithInventoryReconciliation(
  orderId: string,
  input: SalesOrderWriteInput,
  totals: SalesOrderTotals
): Promise<SalesOrder> {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${orderId}))`;

    const before = await tx.salesOrder.findUnique({ where: { id: orderId }, include: orderItemsInclude });
    if (!before) throw new SalesOrderNotFoundError(orderId);

    const oldLines = extractTrackedLines(before.items);
    const wasDeducted = await hasDeductedStock(orderId, tx);

    const { items, ...rest } = input;
    const updated = await tx.salesOrder.update({
      where: { id: orderId },
      data: { ...rest, ...totals, items: { deleteMany: {}, create: items } },
      include: orderItemsInclude,
    });
    const newLines = extractTrackedLines(updated.items);

    const itemsChanged = !linesEqual(oldLines, newLines);
    const statusChanged = before.status !== updated.status;

    if (wasDeducted && (itemsChanged || statusChanged)) {
      await applySalesOrderLineMovements(oldLines, 'IN', {
        salesOrderId: orderId,
        reason: `Sales order ${updated.number} edited - stock reversed for update`,
        db: tx,
      });
    }

    if (STOCK_HOLDING_STATUSES.has(updated.status)) {
      if (!(await hasDeductedStock(orderId, tx))) {
        await applySalesOrderLineMovements(newLines, 'OUT', {
          salesOrderId: orderId,
          reason: `Sales order ${updated.number} edited - stock applied for updated quantities`,
          db: tx,
        });
      }
    } else if (updated.status === 'CANCELLED') {
      await applySalesOrderInventoryEffect(orderId, 'CANCELLED', tx);
    }

    return updated;
  });
}

export class SalesOrderNotFoundError extends Error {
  constructor(orderId: string) {
    super(`Sales order ${orderId} not found`);
    this.name = 'SalesOrderNotFoundError';
  }
}

export interface CreateInvoiceForOrderResult {
  invoice: Invoice & { items: InvoiceItem[] };
  /** False when an invoice for this order already existed and was returned
   * instead of creating a second one (e.g. a double-click, a retried
   * request, or simply asking again later). */
  created: boolean;
}

/**
 * Creates the invoice for a sales order, or returns the existing one if
 * this order already has an INVOICE-type invoice. This closes a real
 * duplicate-document risk: the previous version of this endpoint created a
 * brand new invoice on every call with no check at all, so a double-click
 * or a retried network request produced two (or more) full invoices for
 * the same order.
 *
 * Concurrency: a Postgres advisory transaction lock keyed by the order id
 * serializes concurrent calls for the *same* order (the lock is held only
 * for the duration of this transaction and is released automatically on
 * commit or rollback), so two simultaneous requests can't both pass the
 * "does an invoice already exist?" check before either has written one.
 * Calls for *different* orders are unaffected and run fully in parallel.
 */
export async function createInvoiceForSalesOrder(
  orderId: string,
  createdById: string
): Promise<CreateInvoiceForOrderResult> {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${orderId}))`;

    const existing = await tx.invoice.findFirst({
      where: { salesOrderId: orderId, type: 'INVOICE' },
      include: { items: true },
      orderBy: { createdAt: 'asc' },
    });
    if (existing) {
      return { invoice: existing, created: false };
    }

    const order = await tx.salesOrder.findUnique({ where: { id: orderId }, include: { items: true } });
    if (!order) throw new SalesOrderNotFoundError(orderId);

    const number = await generateNumber('invoice');
    const invoice = await tx.invoice.create({
      data: {
        number,
        type: 'INVOICE',
        companyId: order.companyId,
        contactId: order.contactId,
        salesOrderId: order.id,
        subtotal: order.subtotal,
        taxTotal: order.taxTotal,
        discountTotal: order.discountTotal,
        total: order.total,
        dueDate: new Date(Date.now() + 1000 * 60 * 60 * 24 * 30),
        createdById,
        items: {
          create: order.items.map((i) => ({
            productId: i.productId,
            productVariantId: i.productVariantId,
            description: i.description,
            quantity: i.quantity,
            unitPrice: i.unitPrice,
            taxRate: i.taxRate,
            discount: i.discount,
          })),
        },
      },
      include: { items: true },
    });

    return { invoice, created: true };
  });
}
