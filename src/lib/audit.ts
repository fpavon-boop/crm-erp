import { prisma } from '@/lib/prisma';

export async function logAudit(params: {
  userId?: string | null;
  action: string;
  entityType: string;
  entityId: string;
  companyId?: string | null;
  changes?: unknown;
}) {
  await prisma.auditLog.create({
    data: {
      userId: params.userId ?? null,
      action: params.action,
      entityType: params.entityType,
      entityId: params.entityId,
      companyId: params.companyId ?? null,
      changes: params.changes ? JSON.parse(JSON.stringify(params.changes)) : undefined,
    },
  });
}
