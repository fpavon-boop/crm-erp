import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { requireCronSecret } from '@/lib/api-auth';
import { runScheduledAutomations } from '@/lib/automations/engine';
import { syncEmailAccount } from '@/lib/email/imap';
import { prisma } from '@/lib/prisma';

export const runtime = 'nodejs';
export const maxDuration = 300;

/**
 * Runs all scheduled automations: overdue invoices, pending orders, low
 * stock, unanswered emails, plus syncing every active email account.
 * Call this periodically from Easypanel's Cron feature (or an external
 * scheduler like cron-job.org) with header `x-cron-secret: $CRON_SECRET`,
 * or trigger it manually from Settings > Automations as an admin.
 */
export async function POST(req: NextRequest) {
  const cronError = requireCronSecret(req);
  if (cronError) {
    const session = await getServerSession(authOptions);
    if (!session?.user || session.user.role !== 'ADMIN') {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
  }

  const results = await runScheduledAutomations();

  const emailAccounts = await prisma.emailAccount.findMany({ where: { active: true } });
  const emailSync = [];
  for (const account of emailAccounts) {
    try {
      const result = await syncEmailAccount(account.id);
      emailSync.push({ account: account.label, ...result });
    } catch (err) {
      emailSync.push({ account: account.label, error: String(err) });
    }
  }

  return NextResponse.json({ ran: true, results, emailSync });
}
