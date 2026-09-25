import { prisma } from '@/lib/prisma';
import { recordStockMovement } from '@/lib/automations/stock';
import { createInvoiceForSalesOrder } from '@/lib/sales-orders';
import { deriveInvoiceStatus } from '@/lib/accounts-receivable';

const EXTERNAL_SOURCE = 'woocommerce';

interface WooCustomer {
  id: number;
  email: string;
  first_name: string;
  last_name: string;
  billing?: { company?: string; phone?: string; address_1?: string; city?: string; country?: string };
}

interface WooProduct {
  id: number;
  sku: string;
  name: string;
  description: string;
  price: string;
  regular_price: string;
  stock_quantity: number | null;
}

interface WooLineItem {
  name: string;
  quantity: number;
  price: string;
  sku?: string;
  product_id?: number;
  variation_id?: number;
  subtotal?: string;
  total?: string;
}

interface WooOrder {
  id: number;
  number: string;
  status: string;
  total: string;
  total_tax?: string;
  discount_total?: string;
  shipping_total?: string;
  currency: string;
  date_created_gmt?: string;
  // Phase 11 (SYSTEM_AUDIT.md L): when WooCommerce itself reports this
  // order as paid, these describe that payment. date_paid_gmt is absent on
  // an order that was never paid (e.g. still 'pending'/'on-hold').
  date_paid_gmt?: string;
  payment_method_title?: string;
  billing: {
    email: string;
    first_name: string;
    last_name: string;
    company?: string;
    phone?: string;
    address_1?: string;
    address_2?: string;
    city?: string;
    state?: string;
    postcode?: string;
    country?: string;
  };
  line_items: WooLineItem[];
}

/** Records a sync problem somewhere an administrator will actually see it
 * (the same AutomationLog table already used for WhatsApp webhook
 * failures), instead of only a caught-and-discarded exception. Never pass
 * anything that could contain the consumer key/secret. */
async function logSyncIssue(siteId: string, entityId: string | undefined, message: string) {
  await prisma.automationLog
    .create({
      data: { entityType: 'WOOCOMMERCE_SYNC', entityId: entityId ?? siteId, success: false, message },
    })
    .catch(() => undefined);
}

/** WooCommerce's REST API supports two authentication modes: HTTP Basic
 * Auth (consumer key/secret as username/password) over HTTPS, or
 * oauth1-style query-string parameters for plain HTTP. Basic Auth is what
 * WooCommerce's own docs recommend for HTTPS stores — the credentials
 * travel in a header, not a URL, so they can't end up in web-server access
 * logs, browser history, or a proxy's request log the way a query string
 * can. Every real store here is expected to be HTTPS (Easypanel enforces
 * it), so the query-string path only exists as a documented fallback. */
function wooCredentials(): { key: string; secret: string } {
  const key = process.env.WOOCOMMERCE_CONSUMER_KEY;
  const secret = process.env.WOOCOMMERCE_CONSUMER_SECRET;
  if (!key || !secret) throw new Error('WooCommerce keys are not configured');
  return { key, secret };
}

async function wooFetch<T>(baseUrl: string, endpoint: string): Promise<T[]> {
  const { key, secret } = wooCredentials();
  const secure = baseUrl.startsWith('https://');
  const all: T[] = [];
  for (let page = 1; page <= 50; page += 1) {
    const url = secure
      ? `${baseUrl}/wp-json/wc/v3/${endpoint}?per_page=100&page=${page}`
      : `${baseUrl}/wp-json/wc/v3/${endpoint}?per_page=100&page=${page}&consumer_key=${encodeURIComponent(key)}&consumer_secret=${encodeURIComponent(secret)}`;
    const res = await fetch(url, {
      headers: secure ? { Authorization: `Basic ${Buffer.from(`${key}:${secret}`).toString('base64')}` } : undefined,
    });
    // Never include `url` here — on the non-HTTPS fallback path it carries
    // the consumer secret in plain text.
    if (!res.ok) throw new Error(`WooCommerce API error ${res.status} on ${endpoint} (page ${page})`);
    const batch: T[] = await res.json();
    all.push(...batch);
    if (batch.length < 100) break;
  }
  return all;
}

/** Finds or creates the Contact (and Company, when the billing details name
 * one) for an order, so guest checkouts are linked to who actually bought.
 * Reused CRM-wide by matching on email first (a WooCommerce "customer" and
 * a WooCommerce "guest order" for the same person must resolve to the same
 * Contact, not two). The create path is wrapped in a transaction and
 * re-checks for the contact once more immediately before creating it, to
 * narrow (not fully eliminate — Contact.email has no unique constraint at
 * the database level) the window for a duplicate under concurrent access;
 * syncWooCommerce()'s own in-flight guard prevents the most likely source
 * of that concurrency (two syncs of the same site overlapping). */
async function resolveOrderCustomer(billing: WooOrder['billing']) {
  const email = billing.email?.trim().toLowerCase();
  if (!email) return { contactId: undefined, companyId: undefined };

  const existing = await prisma.contact.findFirst({ where: { email: { equals: email, mode: 'insensitive' } } });
  if (existing) return { contactId: existing.id, companyId: existing.companyId ?? undefined };

  return prisma.$transaction(async (tx) => {
    const recheck = await tx.contact.findFirst({ where: { email: { equals: email, mode: 'insensitive' } } });
    if (recheck) return { contactId: recheck.id, companyId: recheck.companyId ?? undefined };

    let companyId: string | undefined;
    const companyName = billing.company?.trim();
    if (companyName) {
      const existingCompany = await tx.company.findFirst({ where: { name: { equals: companyName, mode: 'insensitive' } } });
      const company =
        existingCompany ??
        (await tx.company.create({
          data: {
            name: companyName,
            type: 'CUSTOMER',
            addressLine1: billing.address_1 || null,
            addressLine2: billing.address_2 || null,
            city: billing.city || null,
            state: billing.state || null,
            postalCode: billing.postcode || null,
            country: billing.country || null,
          },
        }));
      companyId = company.id;
    }
    const contact = await tx.contact.create({
      data: {
        firstName: billing.first_name || 'Customer',
        lastName: billing.last_name || '-',
        email,
        phone: billing.phone || null,
        companyId,
        externalSource: EXTERNAL_SOURCE,
        externalId: `guest:${email}`,
      },
    });
    return { contactId: contact.id, companyId: contact.companyId ?? undefined };
  });
}

/** Upserts a Product for a WooCommerce product, keyed primarily by the
 * stable WooCommerce id (externalSource/externalId) rather than SKU alone
 * — a SKU rename in WooCommerce no longer orphans the CRM row and creates
 * a duplicate. SKU is still used as the secondary matching key: a
 * CRM-native product that already has the same SKU (created before this
 * product was ever synced) is adopted and linked, rather than duplicated.
 * A SKU that's already claimed by a *different* CRM product than the one
 * matched by externalId is left alone and reported as a warning, rather
 * than silently overwritten. */
async function upsertWooProduct(p: WooProduct, warnings: string[]) {
  const sku = p.sku?.trim() || `woo-${p.id}`;
  const externalId = String(p.id);
  const fields = {
    name: p.name,
    description: p.description ? p.description.replace(/<[^>]+>/g, ' ').trim() || null : null,
    price: Number(p.price || p.regular_price || 0),
    // Woo only reports a quantity for products it manages stock for; the
    // rest would otherwise show as permanently "low stock" here.
    trackInventory: p.stock_quantity !== null,
  };

  const byExternalId = await prisma.product.findUnique({
    where: { externalSource_externalId: { externalSource: EXTERNAL_SOURCE, externalId } },
  });
  if (byExternalId) {
    let skuUpdate: { sku?: string } = {};
    if (sku !== byExternalId.sku) {
      const skuOwner = await prisma.product.findUnique({ where: { sku } });
      if (!skuOwner) {
        skuUpdate = { sku };
      } else if (skuOwner.id !== byExternalId.id) {
        warnings.push(
          `WooCommerce product ${p.id} now has SKU "${sku}", but that SKU already belongs to a different CRM product (${skuOwner.id}). Keeping the existing CRM SKU "${byExternalId.sku}" unchanged.`
        );
      }
    }
    return prisma.product.update({ where: { id: byExternalId.id }, data: { ...fields, ...skuUpdate } });
  }

  const bySku = await prisma.product.findUnique({ where: { sku } });
  if (bySku) {
    return prisma.product.update({
      where: { id: bySku.id },
      data: { ...fields, externalSource: EXTERNAL_SOURCE, externalId },
    });
  }

  return prisma.product.create({ data: { sku, ...fields, externalSource: EXTERNAL_SOURCE, externalId } });
}

/** Upserts the single default ProductVariant WooCommerce simple products
 * map to, keyed by the same WooCommerce product id. WooCommerce
 * *variable* product variations (each with their own id/SKU/stock) are not
 * fetched or represented individually — see docs/WOOCOMMERCE_INTEGRATION.md
 * ("Known limitations"). */
async function upsertWooVariant(product: { id: string; sku: string }, externalId: string) {
  const sku = `${product.sku}-default`;
  const byExternalId = await prisma.productVariant.findUnique({
    where: { externalSource_externalId: { externalSource: EXTERNAL_SOURCE, externalId } },
  });
  if (byExternalId) {
    const skuUpdate = sku !== byExternalId.sku ? { sku } : {};
    return prisma.productVariant.update({ where: { id: byExternalId.id }, data: skuUpdate });
  }
  const bySku = await prisma.productVariant.findUnique({ where: { sku } });
  if (bySku) {
    return prisma.productVariant.update({
      where: { id: bySku.id },
      data: { externalSource: EXTERNAL_SOURCE, externalId },
    });
  }
  return prisma.productVariant.create({
    data: { productId: product.id, sku, name: 'Default', externalSource: EXTERNAL_SOURCE, externalId },
  });
}

/** Applies WooCommerce's reported stock quantity as a visible, ledgered
 * stock movement rather than a silent absolute overwrite of StockLevel —
 * the delta between what's currently on hand and what WooCommerce reports
 * is posted through the same recordStockMovement() used by every other
 * inventory-affecting path in the app (Phase 1), so it shows up in the
 * StockMovement history like any other change and can never drive
 * StockLevel negative. A zero delta posts nothing (no-op resync). */
async function applyWooStockLevel(variantId: string, warehouseId: string, wooQuantity: number) {
  const current = await prisma.stockLevel.findUnique({
    where: { productVariantId_warehouseId: { productVariantId: variantId, warehouseId } },
  });
  const delta = wooQuantity - (current?.quantity ?? 0);
  if (delta === 0) return;
  await recordStockMovement({
    productVariantId: variantId,
    warehouseId,
    type: delta > 0 ? 'IN' : 'OUT',
    quantity: Math.abs(delta),
    reason: 'WooCommerce stock sync',
    referenceType: 'WOOCOMMERCE_SYNC',
    referenceId: variantId,
  });
}

/** A WooCommerce line item's `sku` is the *product's* SKU as configured in
 * WooCommerce — never the CRM's internal `${sku}-default` variant SKU — so
 * once a Product is matched (by SKU or by WooCommerce id), its variant is
 * looked up separately rather than expecting the line item's SKU to match
 * the variant row directly. Every WooCommerce-synced product has at most
 * one variant (the "Default" one — see upsertWooVariant), so this is
 * unambiguous today; it stops being unambiguous only if true WooCommerce
 * *variation* support is added later (see docs/WOOCOMMERCE_INTEGRATION.md,
 * "Known limitations"). */
async function findProductVariant(productId: string) {
  const variant = await prisma.productVariant.findFirst({ where: { productId } });
  return variant?.id;
}

/** Resolves a WooCommerce order line to a CRM Product/ProductVariant: SKU
 * first (the audit's required primary mapping key), falling back to the
 * WooCommerce product/variation id once SKU match fails. If neither
 * resolves, the line is still imported (never silently discarded) with no
 * product link, and a warning is returned for the caller to log. */
async function resolveLineItemProduct(
  li: WooLineItem
): Promise<{ productId?: string; productVariantId?: string; warning?: string }> {
  const sku = li.sku?.trim();
  if (sku) {
    const variant = await prisma.productVariant.findUnique({ where: { sku } });
    if (variant) return { productId: variant.productId, productVariantId: variant.id };
    const product = await prisma.product.findUnique({ where: { sku } });
    if (product) return { productId: product.id, productVariantId: await findProductVariant(product.id) };
  }
  if (li.product_id) {
    const product = await prisma.product.findUnique({
      where: { externalSource_externalId: { externalSource: EXTERNAL_SOURCE, externalId: String(li.product_id) } },
    });
    if (product) {
      if (li.variation_id) {
        const variant = await prisma.productVariant.findUnique({
          where: {
            externalSource_externalId: { externalSource: EXTERNAL_SOURCE, externalId: String(li.variation_id) },
          },
        });
        if (variant) return { productId: product.id, productVariantId: variant.id };
      }
      return { productId: product.id, productVariantId: await findProductVariant(product.id) };
    }
  }
  return {
    warning: `Unknown SKU for order line "${li.name}"${sku ? ` (sku: "${sku}")` : ' (no sku on the line item)'} — the line was still imported, without a product link.`,
  };
}

/** WooCommerce order financial fields, mapped onto the four SalesOrder
 * money columns. `subtotal` is summed from each line item's own subtotal
 * (the pre-discount line total WooCommerce reports) rather than derived by
 * subtracting tax/shipping/discount from the grand total, which is more
 * direct and avoids compounding rounding error across several
 * subtractions. There's no dedicated "shipping" column on SalesOrder, so a
 * shipping charge is represented as its own order line (see
 * buildOrderItemsData) rather than folded silently into another field. */
function computeOrderTotals(o: WooOrder) {
  const taxTotal = Number(o.total_tax || 0);
  const discountTotal = Number(o.discount_total || 0);
  const shippingTotal = Number(o.shipping_total || 0);
  const total = Number(o.total || 0);
  const subtotal = o.line_items.reduce((sum, li) => {
    const lineSubtotal = li.subtotal !== undefined ? Number(li.subtotal) : Number(li.price) * li.quantity;
    return sum + (Number.isFinite(lineSubtotal) ? lineSubtotal : 0);
  }, 0);
  return { subtotal, taxTotal, discountTotal, shippingTotal, total };
}

async function buildOrderItemsData(o: WooOrder, warnings: string[], siteId: string) {
  const items: Array<{
    productId?: string;
    productVariantId?: string;
    description: string;
    quantity: number;
    unitPrice: number;
  }> = [];

  for (const li of o.line_items) {
    const resolved = await resolveLineItemProduct(li);
    if (resolved.warning) {
      warnings.push(resolved.warning);
      await logSyncIssue(siteId, String(o.id), resolved.warning);
    }
    items.push({
      productId: resolved.productId,
      productVariantId: resolved.productVariantId,
      description: li.name,
      quantity: li.quantity,
      unitPrice: Number(li.price),
    });
  }

  const totals = computeOrderTotals(o);
  if (totals.shippingTotal > 0) {
    items.push({ description: 'Shipping', quantity: 1, unitPrice: totals.shippingTotal });
  }

  return { items, totals };
}

/** The raw WooCommerce order statuses that mean "the customer has paid" —
 * checked against the order's *own* status string, before mapWooStatus()
 * maps it onto a SalesOrderStatus, since 'processing' and 'completed' both
 * map to different SalesOrderStatus values but mean the same thing
 * financially. */
const WOO_PAID_STATUSES = new Set(['processing', 'completed']);

/**
 * Records a Payment for a WooCommerce order Woo itself reports as paid
 * ('processing' or 'completed') — SYSTEM_AUDIT.md L: previously a
 * WooCommerce order counted as "sold" in Finance but never as "received",
 * because nothing here ever created a Payment row for one, even though the
 * customer already paid online.
 *
 * Ensures an Invoice exists for the order first (auto-creating one via the
 * same createInvoiceForSalesOrder() the "Create Invoice" button uses —
 * idempotent, so a manually-created invoice is reused, not duplicated),
 * then records the payment against it.
 *
 * Idempotent by construction: Payment's own (externalSource, externalId)
 * unique constraint — externalId the WooCommerce order id — means a second
 * sync of the same already-recorded paid order hits that constraint and is
 * treated as already-applied, never a duplicate Payment. Checked explicitly
 * first (rather than relying on catching the constraint) so a re-sync is a
 * silent, cheap no-op rather than a caught error on every subsequent sync.
 *
 * Assumes the order was paid in full — WooCommerce's REST API doesn't
 * expose a distinct "amount paid so far" for a simple order, and
 * 'processing'/'completed' are the statuses a standard checkout reaches
 * only after the configured payment gateway confirms full payment. See
 * docs/FINANCIAL_ACCURACY_AND_AUTOMATION.md "Known limitations" for what
 * this does not cover (partial/split payments).
 */
async function recordPaymentForPaidWooOrder(
  salesOrderId: string,
  o: WooOrder,
  warnings: string[],
  siteId: string
): Promise<void> {
  if (!WOO_PAID_STATUSES.has(o.status)) return;
  const amount = Number(o.total || 0);
  if (!(amount > 0)) return;

  const externalId = String(o.id);
  const already = await prisma.payment.findUnique({
    where: { externalSource_externalId: { externalSource: EXTERNAL_SOURCE, externalId } },
  });
  if (already) return; // already recorded on a prior sync — nothing to do

  try {
    const { invoice } = await createInvoiceForSalesOrder(salesOrderId, null);

    const paidAtRaw = o.date_paid_gmt || o.date_created_gmt;
    const paidAt = paidAtRaw ? new Date(`${paidAtRaw}Z`) : new Date();

    await prisma.$transaction(async (tx) => {
      await tx.payment.create({
        data: {
          invoiceId: invoice.id,
          amount,
          method: o.payment_method_title || 'WooCommerce',
          reference: `WooCommerce order #${o.number}`,
          paidAt: Number.isNaN(paidAt.getTime()) ? new Date() : paidAt,
          externalSource: EXTERNAL_SOURCE,
          externalId,
        },
      });

      const fresh = await tx.invoice.findUniqueOrThrow({ where: { id: invoice.id } });
      const newPaid = Number(fresh.amountPaid) + amount;
      // A freshly auto-created invoice starts life as DRAFT (the schema
      // default) — deriveInvoiceStatus() deliberately never moves a DRAFT
      // invoice on its own (DRAFT/CANCELLED are treated as manually-set,
      // terminal states elsewhere in this app). That rule exists for a
      // human-managed invoice that genuinely hasn't been issued yet; this
      // one represents an already-completed, already-paid transaction, so
      // it's evaluated as if it started SENT rather than DRAFT — the
      // amountPaid-vs-total precedence in deriveInvoiceStatus then
      // correctly resolves it straight to PAID.
      const baseStatus = fresh.status === 'DRAFT' ? 'SENT' : fresh.status;
      const status = deriveInvoiceStatus({ status: baseStatus, total: Number(fresh.total), amountPaid: newPaid, dueDate: fresh.dueDate });
      await tx.invoice.update({ where: { id: fresh.id }, data: { amountPaid: newPaid, status } });
    });
  } catch (err) {
    const message = `Failed to record payment for WooCommerce order ${o.id} (#${o.number}): ${err instanceof Error ? err.message : String(err)}`;
    warnings.push(message);
    await logSyncIssue(siteId, String(o.id), message);
  }
}

/**
 * Reverses a previously-recorded WooCommerce payment when Woo reports the
 * order as 'refunded' — SYSTEM_AUDIT.md K: a refund is a distinct financial
 * event from a plain cancellation (money that was received and then
 * returned, not a sale that never happened) and must be reflected as such
 * rather than silently vanishing into the same CANCELLED bucket.
 *
 * Mirrors the existing Stripe refund handler's own logic exactly
 * (`handleChargeRefunded` in src/lib/stripe/webhook.ts): tracked via the
 * Payment's own `refundedAmount` field (shared with Stripe, not a second
 * parallel field), idempotent by comparing against the delta already
 * applied, and re-derives the invoice's status/amountPaid the same way a
 * Stripe refund does.
 *
 * Treats a WooCommerce 'refunded' order as a full refund of whatever was
 * recorded as paid for it — see docs/FINANCIAL_ACCURACY_AND_AUTOMATION.md
 * "Known limitations" for why (WooCommerce's order-level status doesn't
 * distinguish a partial from a full refund; a partial refund normally
 * leaves the order in its prior status with a separate refund record this
 * sync does not fetch).
 *
 * If no Payment was ever recorded for this order (it was refunded before
 * ever being synced in a paid state, or was paid outside what this sync
 * tracks), there is nothing to reverse — logged as a warning rather than
 * fabricating a payment to then refund.
 */
async function reverseWooOrderPaymentIfRefunded(o: WooOrder, warnings: string[], siteId: string): Promise<void> {
  if (o.status !== 'refunded') return;

  const externalId = String(o.id);
  const payment = await prisma.payment.findUnique({
    where: { externalSource_externalId: { externalSource: EXTERNAL_SOURCE, externalId } },
  });
  if (!payment) {
    const message = `WooCommerce order ${o.id} (#${o.number}) was refunded, but no Payment was ever recorded for it — nothing to reverse.`;
    warnings.push(message);
    await logSyncIssue(siteId, String(o.id), message);
    return;
  }

  const fullAmount = Number(payment.amount);
  const delta = fullAmount - Number(payment.refundedAmount);
  if (delta <= 0) return; // already fully reflects this refund — re-sync of an already-refunded order

  try {
    await prisma.$transaction(async (tx) => {
      await tx.payment.update({ where: { id: payment.id }, data: { refundedAmount: fullAmount } });

      const invoice = await tx.invoice.findUniqueOrThrow({ where: { id: payment.invoiceId } });
      const newPaid = Math.max(0, Number(invoice.amountPaid) - delta);
      await tx.invoice.update({
        where: { id: invoice.id },
        data: {
          amountPaid: newPaid,
          status: deriveInvoiceStatus({ status: invoice.status, total: Number(invoice.total), amountPaid: newPaid, dueDate: invoice.dueDate }),
        },
      });
    });
  } catch (err) {
    const message = `Failed to reverse payment for refunded WooCommerce order ${o.id} (#${o.number}): ${err instanceof Error ? err.message : String(err)}`;
    warnings.push(message);
    await logSyncIssue(siteId, String(o.id), message);
  }
}

/** Guards against two syncs of the same site running at once (SYSTEM_AUDIT.md
 * E4) — both would race on the same upserts and customer-resolution
 * checks. This app runs as a single Node process/container (see
 * docs/SYSTEM_AUDIT.md section A), so an in-process guard closes the
 * realistic race without the correctness risk a Postgres *session-level*
 * advisory lock would carry under Prisma's connection pooling (no
 * guarantee the lock and unlock calls land on the same underlying
 * connection) or the cost of holding a transaction open across many slow
 * external HTTP calls to WooCommerce. */
const syncsInFlight = new Set<string>();

/** Syncs WooCommerce customers, products, and orders into the CRM/ERP
 * models. Idempotent: matches existing records via externalSource
 * ="woocommerce" + externalId (Company, Contact, Product, ProductVariant,
 * SalesOrder all now carry this), so re-running never creates duplicates.
 * Errors are captured per item (never silently swallowed) and returned as
 * `warnings`, and also written to AutomationLog for visibility outside
 * this one response. See docs/WOOCOMMERCE_INTEGRATION.md. */
export async function syncWooCommerce(siteId: string): Promise<{
  customers: number;
  products: number;
  orders: number;
  warnings: string[];
}> {
  if (syncsInFlight.has(siteId)) {
    throw new Error('A WooCommerce sync for this site is already in progress.');
  }
  syncsInFlight.add(siteId);

  const warnings: string[] = [];
  try {
    const site = await prisma.wordPressSite.findUniqueOrThrow({ where: { id: siteId } });
    let customers = 0;
    let products = 0;
    let orders = 0;

    let wooCustomers: WooCustomer[] = [];
    try {
      wooCustomers = await wooFetch<WooCustomer>(site.baseUrl, 'customers');
    } catch (err) {
      const message = `Failed to fetch WooCommerce customers: ${err instanceof Error ? err.message : String(err)}`;
      warnings.push(message);
      await logSyncIssue(siteId, undefined, message);
    }
    for (const c of wooCustomers) {
      try {
        const company = c.billing?.company
          ? await prisma.company.upsert({
              where: { externalSource_externalId: { externalSource: EXTERNAL_SOURCE, externalId: String(c.id) } },
              create: {
                name: c.billing.company,
                type: 'CUSTOMER',
                externalSource: EXTERNAL_SOURCE,
                externalId: String(c.id),
                city: c.billing.city,
                country: c.billing.country,
              },
              update: { name: c.billing.company, city: c.billing.city, country: c.billing.country },
            })
          : null;

        await prisma.contact.upsert({
          where: { externalSource_externalId: { externalSource: EXTERNAL_SOURCE, externalId: String(c.id) } },
          create: {
            firstName: c.first_name || 'Customer',
            lastName: c.last_name || String(c.id),
            email: c.email,
            phone: c.billing?.phone,
            companyId: company?.id,
            externalSource: EXTERNAL_SOURCE,
            externalId: String(c.id),
          },
          update: {
            firstName: c.first_name || 'Customer',
            lastName: c.last_name || String(c.id),
            email: c.email,
            phone: c.billing?.phone,
          },
        });
        customers += 1;
      } catch (err) {
        const message = `Failed to sync WooCommerce customer ${c.id} (${c.email}): ${err instanceof Error ? err.message : String(err)}`;
        warnings.push(message);
        await logSyncIssue(siteId, String(c.id), message);
      }
    }

    let wooProducts: WooProduct[] = [];
    try {
      wooProducts = await wooFetch<WooProduct>(site.baseUrl, 'products');
    } catch (err) {
      const message = `Failed to fetch WooCommerce products: ${err instanceof Error ? err.message : String(err)}`;
      warnings.push(message);
      await logSyncIssue(siteId, undefined, message);
    }
    const defaultWarehouse = await prisma.warehouse.findFirst({ where: { isDefault: true } });
    for (const p of wooProducts) {
      try {
        const product = await upsertWooProduct(p, warnings);

        if (p.stock_quantity !== null && defaultWarehouse) {
          const variant = await upsertWooVariant(product, String(p.id));
          await applyWooStockLevel(variant.id, defaultWarehouse.id, p.stock_quantity);
        } else if (p.stock_quantity !== null && !defaultWarehouse) {
          const message = `Product ${p.id} (${p.sku || 'no sku'}) reports stock, but no default warehouse exists to apply it to.`;
          warnings.push(message);
          await logSyncIssue(siteId, String(p.id), message);
        }
        products += 1;
      } catch (err) {
        const message = `Failed to sync WooCommerce product ${p.id} (${p.sku || 'no sku'}): ${err instanceof Error ? err.message : String(err)}`;
        warnings.push(message);
        await logSyncIssue(siteId, String(p.id), message);
      }
    }

    let wooOrders: WooOrder[] = [];
    try {
      wooOrders = await wooFetch<WooOrder>(site.baseUrl, 'orders');
    } catch (err) {
      const message = `Failed to fetch WooCommerce orders: ${err instanceof Error ? err.message : String(err)}`;
      warnings.push(message);
      await logSyncIssue(siteId, undefined, message);
    }
    for (const o of wooOrders) {
      try {
        const { contactId, companyId } = await resolveOrderCustomer(o.billing);
        const { items, totals } = await buildOrderItemsData(o, warnings, siteId);
        // Woo GMT timestamps carry no zone suffix; keep the real order date.
        const createdAt = o.date_created_gmt ? new Date(`${o.date_created_gmt}Z`) : undefined;
        const validCreatedAt = createdAt && !Number.isNaN(createdAt.getTime()) ? createdAt : undefined;

        const salesOrder = await prisma.salesOrder.upsert({
          where: { externalSource_externalId: { externalSource: EXTERNAL_SOURCE, externalId: String(o.id) } },
          create: {
            number: `WOO-${o.number}`,
            status: mapWooStatus(o.status),
            subtotal: totals.subtotal,
            taxTotal: totals.taxTotal,
            discountTotal: totals.discountTotal,
            total: totals.total,
            contactId,
            companyId,
            ...(validCreatedAt ? { createdAt: validCreatedAt } : {}),
            externalSource: EXTERNAL_SOURCE,
            externalId: String(o.id),
            items: { create: items },
          },
          update: {
            status: mapWooStatus(o.status),
            subtotal: totals.subtotal,
            taxTotal: totals.taxTotal,
            discountTotal: totals.discountTotal,
            total: totals.total,
            contactId,
            companyId,
            ...(validCreatedAt ? { createdAt: validCreatedAt } : {}),
            // Line items are deliberately NOT touched on update: this order
            // may already have been edited/confirmed in the CRM (with its
            // own inventory effects — see docs/INVENTORY_RULES.md), and
            // blindly replacing its items here would bypass that
            // reconciliation entirely. Only re-run a fresh sync of a
            // never-yet-imported order to pick up item changes.
          },
        });
        orders += 1;

        // Phase 11 (SYSTEM_AUDIT.md L, K) — payment/refund reconciliation.
        // Each of these catches its own errors internally and never throws,
        // so a payment/refund failure is recorded as its own warning
        // without being misattributed to (or mistaken for) an order sync
        // failure, and never rolls back the order upsert that already
        // succeeded just above.
        await recordPaymentForPaidWooOrder(salesOrder.id, o, warnings, siteId);
        await reverseWooOrderPaymentIfRefunded(o, warnings, siteId);
      } catch (err) {
        const message = `Failed to sync WooCommerce order ${o.id} (#${o.number}): ${err instanceof Error ? err.message : String(err)}`;
        warnings.push(message);
        await logSyncIssue(siteId, String(o.id), message);
      }
    }

    return { customers, products, orders, warnings };
  } finally {
    syncsInFlight.delete(siteId);
  }
}

function mapWooStatus(status: string): 'DRAFT' | 'CONFIRMED' | 'SHIPPED' | 'DELIVERED' | 'CANCELLED' | 'REFUNDED' {
  switch (status) {
    case 'processing':
      return 'CONFIRMED';
    case 'completed':
      return 'DELIVERED';
    case 'shipped':
      return 'SHIPPED';
    case 'cancelled':
    case 'failed':
      return 'CANCELLED';
    // SYSTEM_AUDIT.md K: previously conflated with 'cancelled' — a refund
    // means the sale happened and the money was returned, which is a
    // financially distinct event from an order that was never completed at
    // all. See reverseWooOrderPaymentIfRefunded() for the corresponding
    // Payment-level reversal.
    case 'refunded':
      return 'REFUNDED';
    default:
      return 'DRAFT';
  }
}
