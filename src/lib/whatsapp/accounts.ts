import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';

/** Thrown when two requests race to activate an account at the same time.
 * The database's partial unique index (see migration
 * 20260922180500_whatsapp_account_single_active) is the actual guarantee;
 * this only turns the rare loser's raw P2002 into a clear message. */
export class WhatsAppAccountActivationRaceError extends Error {
  constructor() {
    super('Another account was just activated. Reload and try again.');
    this.name = 'WhatsAppAccountActivationRaceError';
  }
}

function isSingleActiveViolation(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';
}

/** Makes exactly one WhatsAppAccount the active one, deactivating every
 * other account in the same transaction. This is the only place that should
 * ever set `active: true` on a WhatsAppAccount row. */
export async function activateWhatsAppAccount(id: string) {
  try {
    return await prisma.$transaction(async (tx) => {
      await tx.whatsAppAccount.updateMany({
        where: { active: true, id: { not: id } },
        data: { active: false },
      });
      return tx.whatsAppAccount.update({ where: { id }, data: { active: true } });
    });
  } catch (err) {
    if (isSingleActiveViolation(err)) throw new WhatsAppAccountActivationRaceError();
    throw err;
  }
}

export interface CreateWhatsAppAccountInput {
  label: string;
  phoneNumberId: string;
  businessAccountId: string;
  displayPhoneNumber?: string;
  encryptedAccessToken: string;
}

/** Creates a new WhatsAppAccount and makes it the (only) active one,
 * deactivating any previously-active account in the same transaction —
 * matching how a new account has always been intended to work, but now
 * without ever leaving two accounts active at once. */
export async function createActiveWhatsAppAccount(input: CreateWhatsAppAccountInput) {
  try {
    return await prisma.$transaction(async (tx) => {
      await tx.whatsAppAccount.updateMany({ where: { active: true }, data: { active: false } });
      return tx.whatsAppAccount.create({ data: { ...input, active: true } });
    });
  } catch (err) {
    if (isSingleActiveViolation(err)) throw new WhatsAppAccountActivationRaceError();
    throw err;
  }
}
