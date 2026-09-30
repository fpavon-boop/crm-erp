import { z, ZodError } from 'zod';
import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { canPerform, type MarketingAction } from '@/marketing/security/rbac';
import { marketingErrors } from '@/marketing/errors';

/**
 * Social account registry (Facebook / Instagram / TikTok). Stores only the
 * platform account identity and the NAME of the n8n credential that holds
 * the token — never a token. Writes are ADMIN-only (`manage_accounts`).
 * Accounts are never deleted (posts reference them, FK Restrict); disconnect
 * or revoke via status instead.
 */

type Db = Pick<typeof prisma, 'socialAccount'>;
export interface Actor {
  userId: string;
  role: string;
}

function requireAction(actor: Actor, action: MarketingAction) {
  if (!canPerform(actor.role, action)) throw marketingErrors.forbidden(`Role ${actor.role} cannot ${action.replace(/_/g, ' ')}`);
}

function parse<T>(schema: z.ZodType<T, any, unknown>, value: unknown): T {
  try {
    return schema.parse(value);
  } catch (err) {
    if (err instanceof ZodError) throw marketingErrors.invalidInput('Invalid social account input', err.flatten());
    throw err;
  }
}

// Credential references are names, not secrets: reject anything token-shaped.
const credentialRef = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .regex(/^[A-Za-z0-9 _.:-]+$/, 'n8nCredentialRef must be the n8n credential NAME, not a token');

const createSchema = z
  .object({
    platform: z.enum(['FACEBOOK', 'INSTAGRAM', 'TIKTOK']),
    externalAccountId: z.string().trim().min(1).max(100).regex(/^[A-Za-z0-9_.:-]+$/),
    handle: z.string().trim().max(100).optional(),
    displayName: z.string().trim().max(200).optional(),
    n8nCredentialRef: credentialRef.optional(),
  })
  .strict();

const updateSchema = z
  .object({
    handle: z.string().trim().max(100).nullable().optional(),
    displayName: z.string().trim().max(200).nullable().optional(),
    n8nCredentialRef: credentialRef.nullable().optional(),
    status: z.enum(['ACTIVE', 'DISCONNECTED', 'REVOKED']).optional(),
  })
  .strict();

export async function listSocialAccounts(query: { platform?: string; status?: string }, actor: Actor, db: Db = prisma) {
  requireAction(actor, 'view');
  const q = parse(z.object({ platform: z.enum(['FACEBOOK', 'INSTAGRAM', 'TIKTOK']).optional(), status: z.enum(['ACTIVE', 'DISCONNECTED', 'REVOKED']).optional() }), query);
  const where: Prisma.SocialAccountWhereInput = { ...(q.platform ? { platform: q.platform } : {}), ...(q.status ? { status: q.status } : {}) };
  return db.socialAccount.findMany({ where, orderBy: [{ platform: 'asc' }, { handle: 'asc' }] });
}

export async function createSocialAccount(input: unknown, actor: Actor, db: Db = prisma) {
  requireAction(actor, 'manage_accounts');
  const a = parse(createSchema, input);
  const existing = await db.socialAccount.findFirst({ where: { platform: a.platform, externalAccountId: a.externalAccountId }, select: { id: true } });
  if (existing) throw marketingErrors.duplicate(`${a.platform} account ${a.externalAccountId} is already registered`, { existingId: existing.id });
  return db.socialAccount.create({ data: { ...a, status: 'ACTIVE' } });
}

export async function updateSocialAccount(id: string, patch: unknown, actor: Actor, db: Db = prisma) {
  requireAction(actor, 'manage_accounts');
  const p = parse(updateSchema, patch);
  const existing = await db.socialAccount.findUnique({ where: { id }, select: { id: true } });
  if (!existing) throw marketingErrors.notFound('Social account', id);
  return db.socialAccount.update({ where: { id }, data: p });
}
