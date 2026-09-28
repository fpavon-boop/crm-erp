import { z, ZodError } from 'zod';
import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { DEFAULT_PAGE_SIZE, pageWindow, totalPages } from '@/lib/pagination';
import { canPerform, type MarketingAction } from '@/marketing/security/rbac';
import { marketingErrors } from '@/marketing/errors';
import { audienceCriteriaSchema, compileContactWhere, type AudienceCriteria, type MessagingChannel } from './rules';
import { decideConsent, type ExclusionReason } from './consent';

/**
 * Audience definitions (rules only) and read-only recipient resolution
 * against the CRM. The only marketing write here is the audience row itself
 * (plus a cached size); CRM tables are only read.
 */

export type AudienceDb = Pick<typeof prisma, 'marketingAudience' | 'contact' | 'wordPressLead' | 'communicationLog'>;

export interface AudienceDeps {
  db: AudienceDb;
  now(): Date;
}

export const defaultAudienceDeps: AudienceDeps = { db: prisma, now: () => new Date() };

export interface Actor {
  userId: string;
  role: string;
}

function requireAction(actor: Actor, action: MarketingAction) {
  if (!canPerform(actor.role, action)) throw marketingErrors.forbidden(`Role ${actor.role} cannot ${action.replace(/_/g, ' ')} audiences`);
}

function parse<T>(schema: z.ZodType<T, any, unknown>, value: unknown): T {
  try {
    return schema.parse(value);
  } catch (err) {
    if (err instanceof ZodError) throw marketingErrors.invalidInput('Invalid audience input', err.flatten());
    throw err;
  }
}

const audienceSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    description: z.string().trim().max(500).optional(),
    channel: z.enum(['EMAIL', 'WHATSAPP']),
    criteria: audienceCriteriaSchema,
  })
  .strict();

export async function createAudience(input: unknown, actor: Actor, deps: AudienceDeps = defaultAudienceDeps) {
  requireAction(actor, 'draft');
  const a = parse(audienceSchema, input);
  return deps.db.marketingAudience.create({
    data: { name: a.name, description: a.description ?? null, channel: a.channel, criteria: a.criteria as Prisma.InputJsonValue, createdById: actor.userId },
  });
}

export async function updateAudience(id: string, input: unknown, actor: Actor, deps: AudienceDeps = defaultAudienceDeps) {
  requireAction(actor, 'draft');
  const a = parse(audienceSchema, input);
  const existing = await deps.db.marketingAudience.findUnique({ where: { id } });
  if (!existing) throw marketingErrors.notFound('Audience', id);
  return deps.db.marketingAudience.update({
    where: { id },
    data: { name: a.name, description: a.description ?? null, channel: a.channel, criteria: a.criteria as Prisma.InputJsonValue, lastSizeCount: null, lastComputedAt: null },
  });
}

export async function getAudience(id: string, actor: Actor, deps: AudienceDeps = defaultAudienceDeps) {
  requireAction(actor, 'view');
  const a = await deps.db.marketingAudience.findUnique({ where: { id } });
  if (!a) throw marketingErrors.notFound('Audience', id);
  return a;
}

export async function listAudiences(query: { page?: number; pageSize?: number }, actor: Actor, deps: AudienceDeps = defaultAudienceDeps) {
  requireAction(actor, 'view');
  const page = query.page ?? 1;
  const pageSize = Math.min(100, query.pageSize ?? DEFAULT_PAGE_SIZE);
  const [items, total] = await Promise.all([
    deps.db.marketingAudience.findMany({ orderBy: { name: 'asc' }, ...pageWindow(page, pageSize) }),
    deps.db.marketingAudience.count(),
  ]);
  return { items, total, page, pageSize, totalPages: totalPages(total, pageSize) };
}

export interface Recipient {
  contactId: string;
  companyId: string | null;
  firstName: string;
  address: string;
}

export interface Resolution {
  channel: MessagingChannel;
  matched: number;
  eligible: Recipient[];
  excluded: Record<ExclusionReason, number>;
}

/** Hard cap on one resolution so a broad rule can't pull the whole CRM into memory. */
export const MAX_AUDIENCE_SIZE = 5000;

/** Read-only: rules → CRM contacts → CRM consent/opt-out → eligible recipients. */
export async function resolveAudience(audienceId: string, deps: AudienceDeps = defaultAudienceDeps): Promise<Resolution> {
  const audience = await deps.db.marketingAudience.findUnique({ where: { id: audienceId } });
  if (!audience) throw marketingErrors.notFound('Audience', audienceId);
  if (audience.channel !== 'EMAIL' && audience.channel !== 'WHATSAPP') {
    throw marketingErrors.invalidState(`Audience channel ${audience.channel} is not a direct-messaging channel`);
  }
  const channel = audience.channel;
  const criteria: AudienceCriteria = audienceCriteriaSchema.parse(audience.criteria);
  const now = deps.now();

  const contacts = await deps.db.contact.findMany({
    where: compileContactWhere(criteria, channel, now),
    select: { id: true, companyId: true, firstName: true, email: true, phone: true, mobile: true },
    orderBy: { id: 'asc' },
    take: MAX_AUDIENCE_SIZE + 1,
  });
  if (contacts.length > MAX_AUDIENCE_SIZE) {
    throw marketingErrors.unprocessable('AUDIENCE_TOO_LARGE', `Audience matches more than ${MAX_AUDIENCE_SIZE} contacts; narrow the rules`);
  }
  const ids = contacts.map((c) => c.id);
  const [leads, inbound] = ids.length
    ? await Promise.all([
        deps.db.wordPressLead.findMany({ where: { contactId: { in: ids } }, select: { contactId: true, consentGiven: true, submittedAt: true } }),
        deps.db.communicationLog.findMany({
          where: { contactId: { in: ids }, direction: 'INBOUND', type: { in: ['EMAIL', 'WHATSAPP'] } },
          select: { contactId: true, type: true, subject: true, body: true, occurredAt: true },
        }),
      ])
    : [[], []];

  const excluded: Record<ExclusionReason, number> = {
    NO_CONSENT_RECORD: 0,
    CONSENT_NOT_GIVEN: 0,
    OPTED_OUT: 0,
    NO_ADDRESS: 0,
    OUTSIDE_WHATSAPP_WINDOW: 0,
  };
  const eligible: Recipient[] = [];
  for (const c of contacts) {
    const d = decideConsent(c, channel, leads, inbound, now);
    if (d.eligible) eligible.push({ contactId: c.id, companyId: c.companyId, firstName: c.firstName, address: d.address });
    else excluded[d.reason] += 1;
  }
  return { channel, matched: contacts.length, eligible, excluded };
}

/** Counts + a small sample for the UI; caches the eligible count on the audience. */
export async function previewAudience(audienceId: string, actor: Actor, deps: AudienceDeps = defaultAudienceDeps) {
  requireAction(actor, 'view');
  const r = await resolveAudience(audienceId, deps);
  await deps.db.marketingAudience.update({ where: { id: audienceId }, data: { lastSizeCount: r.eligible.length, lastComputedAt: deps.now() } });
  return {
    channel: r.channel,
    matched: r.matched,
    eligibleCount: r.eligible.length,
    excluded: r.excluded,
    sample: r.eligible.slice(0, 20).map((e) => ({ contactId: e.contactId, firstName: e.firstName })),
  };
}
