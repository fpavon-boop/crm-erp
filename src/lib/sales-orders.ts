import { prisma } from '@/lib/prisma';
import type { Invoice, InvoiceItem, SalesOrder, SalesOrderStatus } from '@prisma/client';
import { applySalesOrderInventoryEffect } from '@/lib/automations/stock';
import { generateNumber } from '@/lib/numbering';

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
