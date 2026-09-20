import { prisma } from '@/lib/prisma';

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

interface WooOrder {
  id: number;
  number: string;
  status: string;
  total: string;
  currency: string;
  date_created_gmt?: string;
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
  line_items: Array<{ name: string; quantity: number; price: string; sku?: string }>;
}

function authQuery(): string {
  const key = process.env.WOOCOMMERCE_CONSUMER_KEY;
  const secret = process.env.WOOCOMMERCE_CONSUMER_SECRET;
  if (!key || !secret) throw new Error('WooCommerce keys are not configured');
  return `consumer_key=${encodeURIComponent(key)}&consumer_secret=${encodeURIComponent(secret)}`;
}

async function wooFetch<T>(baseUrl: string, endpoint: string): Promise<T[]> {
  const all: T[] = [];
  for (let page = 1; page <= 50; page += 1) {
    const res = await fetch(`${baseUrl}/wp-json/wc/v3/${endpoint}?per_page=100&page=${page}&${authQuery()}`);
    if (!res.ok) throw new Error(`WooCommerce API error ${res.status} on ${endpoint}`);
    const batch: T[] = await res.json();
    all.push(...batch);
    if (batch.length < 100) break;
  }
  return all;
}

/** Finds or creates the Contact (and Company, when the billing details name
 * one) for an order, so guest checkouts are linked to who actually bought. */
async function resolveOrderCustomer(billing: WooOrder['billing']) {
  const email = billing.email?.trim().toLowerCase();
  if (!email) return { contactId: undefined, companyId: undefined };

  let contact = await prisma.contact.findFirst({ where: { email: { equals: email, mode: 'insensitive' } } });
  if (!contact) {
    let companyId: string | undefined;
    const companyName = billing.company?.trim();
    if (companyName) {
      const existing = await prisma.company.findFirst({ where: { name: { equals: companyName, mode: 'insensitive' } } });
      const company =
        existing ??
        (await prisma.company.create({
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
    contact = await prisma.contact.create({
      data: {
        firstName: billing.first_name || 'Customer',
        lastName: billing.last_name || '-',
        email,
        phone: billing.phone || null,
        companyId,
        externalSource: 'woocommerce',
        externalId: `guest:${email}`,
      },
    });
  }
  return { contactId: contact.id, companyId: contact.companyId ?? undefined };
}

/** Syncs WooCommerce customers, products, and orders into the CRM/ERP models.
 * Idempotent: matches existing records via externalSource="woocommerce" +
 * externalId, so re-running is safe. Inventory stock is written to the
 * default warehouse's StockLevel for tracked products. */
export async function syncWooCommerce(siteId: string): Promise<{
  customers: number;
  products: number;
  orders: number;
}> {
  const site = await prisma.wordPressSite.findUniqueOrThrow({ where: { id: siteId } });
  let customers = 0;
  let products = 0;
  let orders = 0;

  const wooCustomers = await wooFetch<WooCustomer>(site.baseUrl, 'customers').catch(() => []);
  for (const c of wooCustomers) {
    const company = c.billing?.company
      ? await prisma.company.upsert({
          where: { externalSource_externalId: { externalSource: 'woocommerce', externalId: String(c.id) } },
          create: {
            name: c.billing.company,
            type: 'CUSTOMER',
            externalSource: 'woocommerce',
            externalId: String(c.id),
            city: c.billing.city,
            country: c.billing.country,
          },
          update: { name: c.billing.company, city: c.billing.city, country: c.billing.country },
        }).catch(() => null)
      : null;

    await prisma.contact.upsert({
      where: { externalSource_externalId: { externalSource: 'woocommerce', externalId: String(c.id) } },
      create: {
        firstName: c.first_name || 'Customer',
        lastName: c.last_name || String(c.id),
        email: c.email,
        phone: c.billing?.phone,
        companyId: company?.id,
        externalSource: 'woocommerce',
        externalId: String(c.id),
      },
      update: {
        firstName: c.first_name || 'Customer',
        lastName: c.last_name || String(c.id),
        email: c.email,
        phone: c.billing?.phone,
      },
    }).catch(() => null);
    customers += 1;
  }

  const wooProducts = await wooFetch<WooProduct>(site.baseUrl, 'products').catch(() => []);
  const defaultWarehouse = await prisma.warehouse.findFirst({ where: { isDefault: true } });
  for (const p of wooProducts) {
    const product = await prisma.product.upsert({
      where: { sku: p.sku || `woo-${p.id}` },
      create: {
        sku: p.sku || `woo-${p.id}`,
        name: p.name,
        description: p.description ? p.description.replace(/<[^>]+>/g, ' ') : null,
        price: Number(p.price || p.regular_price || 0),
        // Woo only reports a quantity for products it manages stock for;
        // the rest would otherwise show as permanently "low stock" here.
        trackInventory: p.stock_quantity !== null,
        externalSource: 'woocommerce',
        externalId: String(p.id),
      },
      update: {
        name: p.name,
        price: Number(p.price || p.regular_price || 0),
        trackInventory: p.stock_quantity !== null,
      },
    });

    if (p.stock_quantity !== null && defaultWarehouse) {
      const variant = await prisma.productVariant.upsert({
        where: { sku: `${product.sku}-default` },
        create: { productId: product.id, sku: `${product.sku}-default`, name: 'Default' },
        update: {},
      });
      await prisma.stockLevel.upsert({
        where: { productVariantId_warehouseId: { productVariantId: variant.id, warehouseId: defaultWarehouse.id } },
        create: { productVariantId: variant.id, warehouseId: defaultWarehouse.id, quantity: p.stock_quantity },
        update: { quantity: p.stock_quantity },
      });
    }
    products += 1;
  }

  const wooOrders = await wooFetch<WooOrder>(site.baseUrl, 'orders').catch(() => []);
  for (const o of wooOrders) {
    const { contactId, companyId } = await resolveOrderCustomer(o.billing).catch(() => ({
      contactId: undefined,
      companyId: undefined,
    }));
    // Woo GMT timestamps carry no zone suffix; keep the real order date.
    const createdAt = o.date_created_gmt ? new Date(`${o.date_created_gmt}Z`) : undefined;
    await prisma.salesOrder.upsert({
      where: { externalSource_externalId: { externalSource: 'woocommerce', externalId: String(o.id) } },
      create: {
        number: `WOO-${o.number}`,
        status: mapWooStatus(o.status),
        total: Number(o.total),
        subtotal: Number(o.total),
        contactId,
        companyId,
        ...(createdAt && !Number.isNaN(createdAt.getTime()) ? { createdAt } : {}),
        externalSource: 'woocommerce',
        externalId: String(o.id),
        items: {
          create: o.line_items.map((li) => ({
            description: li.name,
            quantity: li.quantity,
            unitPrice: Number(li.price),
          })),
        },
      },
      update: {
        status: mapWooStatus(o.status),
        total: Number(o.total),
        contactId,
        companyId,
        ...(createdAt && !Number.isNaN(createdAt.getTime()) ? { createdAt } : {}),
      },
    }).catch(() => null);
    orders += 1;
  }

  return { customers, products, orders };
}

function mapWooStatus(status: string): 'DRAFT' | 'CONFIRMED' | 'SHIPPED' | 'DELIVERED' | 'CANCELLED' {
  switch (status) {
    case 'processing':
      return 'CONFIRMED';
    case 'completed':
      return 'DELIVERED';
    case 'shipped':
      return 'SHIPPED';
    case 'cancelled':
    case 'refunded':
    case 'failed':
      return 'CANCELLED';
    default:
      return 'DRAFT';
  }
}
