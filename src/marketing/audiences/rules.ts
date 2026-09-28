import { z } from 'zod';
import type { Prisma } from '@prisma/client';
import { STOCK_HOLDING_STATUSES } from '@/lib/automations/stock';

/**
 * Audience rules = a filter DEFINITION over CRM contacts and companies.
 * Stored as JSON on MarketingAudience; compiled to a read-only Prisma
 * `ContactWhereInput` at send/preview time. The CRM stays the system of
 * record — no contact data or member list is ever copied into marketing.
 */

const id = z.string().trim().min(1).max(64);
const label = z.string().trim().min(1).max(100);

export const audienceCriteriaSchema = z
  .object({
    companyTypes: z.array(z.enum(['CUSTOMER', 'SUPPLIER', 'BOTH', 'PARTNER'])).min(1).max(4).optional(),
    companyIds: z.array(id).min(1).max(500).optional(),
    industries: z.array(label).min(1).max(20).optional(),
    states: z.array(label).min(1).max(60).optional(),
    countries: z.array(label).min(1).max(30).optional(),
    /** Contacts (or their company) with a realised order for any of these products. */
    purchasedProductIds: z.array(id).min(1).max(50).optional(),
    /** Realised order within the last N days (combines with purchasedProductIds). */
    purchasedWithinDays: z.number().int().min(1).max(3650).optional(),
    /** No realised order within the last N days (win-back). */
    notPurchasedWithinDays: z.number().int().min(1).max(3650).optional(),
    includeContactIds: z.array(id).min(1).max(1000).optional(),
    excludeContactIds: z.array(id).min(1).max(5000).optional(),
  })
  .strict()
  .refine((c) => !(c.purchasedWithinDays && c.notPurchasedWithinDays), {
    message: 'purchasedWithinDays and notPurchasedWithinDays are mutually exclusive',
  });

export type AudienceCriteria = z.output<typeof audienceCriteriaSchema>;

export type MessagingChannel = 'EMAIL' | 'WHATSAPP';

const DAY = 86_400_000;

/** Pure: criteria → read-only Contact filter (active contacts of active or
 * no companies, with an address for the channel). */
export function compileContactWhere(criteria: AudienceCriteria, channel: MessagingChannel, now: Date): Prisma.ContactWhereInput {
  const and: Prisma.ContactWhereInput[] = [{ active: true }];

  and.push(
    channel === 'EMAIL'
      ? { AND: [{ email: { not: null } }, { email: { not: '' } }] }
      : { OR: [{ AND: [{ mobile: { not: null } }, { mobile: { not: '' } }] }, { AND: [{ phone: { not: null } }, { phone: { not: '' } }] }] }
  );

  const company: Prisma.CompanyWhereInput = {
    active: true,
    ...(criteria.companyTypes ? { type: { in: criteria.companyTypes } } : {}),
    ...(criteria.companyIds ? { id: { in: criteria.companyIds } } : {}),
    ...(criteria.industries ? { industry: { in: criteria.industries, mode: 'insensitive' } } : {}),
    ...(criteria.states ? { state: { in: criteria.states, mode: 'insensitive' } } : {}),
    ...(criteria.countries ? { country: { in: criteria.countries, mode: 'insensitive' } } : {}),
  };
  const filtersCompany = Object.keys(company).length > 1;
  and.push(filtersCompany ? { company: { is: company } } : { OR: [{ companyId: null }, { company: { is: { active: true } } }] });

  const realised = { in: Array.from(STOCK_HOLDING_STATUSES) };
  if (criteria.purchasedProductIds || criteria.purchasedWithinDays) {
    const order: Prisma.SalesOrderWhereInput = {
      status: realised,
      ...(criteria.purchasedWithinDays ? { createdAt: { gte: new Date(now.getTime() - criteria.purchasedWithinDays * DAY) } } : {}),
      ...(criteria.purchasedProductIds ? { items: { some: { productId: { in: criteria.purchasedProductIds } } } } : {}),
    };
    and.push({ OR: [{ salesOrders: { some: order } }, { company: { is: { salesOrders: { some: order } } } }] });
  }
  if (criteria.notPurchasedWithinDays) {
    const recent: Prisma.SalesOrderWhereInput = { status: realised, createdAt: { gte: new Date(now.getTime() - criteria.notPurchasedWithinDays * DAY) } };
    and.push({ salesOrders: { none: recent } });
    and.push({ OR: [{ companyId: null }, { company: { is: { salesOrders: { none: recent } } } }] });
  }

  if (criteria.includeContactIds) and.push({ id: { in: criteria.includeContactIds } });
  if (criteria.excludeContactIds) and.push({ id: { notIn: criteria.excludeContactIds } });
  return { AND: and };
}
