import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { requireCronSecret } from '@/lib/api-auth';
import { runAutomationsTickExclusive } from '@/lib/automations/tick-lock';

export const runtime = 'nodejs';
export const maxDuration = 300;

/**
 * Runs all scheduled automations: overdue invoices, pending orders, low
 * stock, unanswered emails, plus syncing every active email account.
 * Call this periodically from Easypanel's Cron feature (or an external
 * scheduler like cron-job.org) with header `x-cron-secret: $CRON_SECRET`,
 * or trigger it manually from Settings > Automations as an admin.
 *
 * Goes through the shared cross-process lease (SYSTEM_AUDIT.md D4) — if
 * the in-process scheduler or the optional standalone worker is already
 * mid-tick, this call is a safe, immediate no-op (`ran: false`) rather
 * than a duplicate run.
 */
export async function POST(req: NextRequest) {
  const cronError = requireCronSecret(req);
  if (cronError) {
    const session = await getServerSession(authOptions);
    if (!session?.user || session.user.role !== 'ADMIN') {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
  }

  const { ranTick, results, emailSync } = await runAutomationsTickExclusive();

  return NextResponse.json({ ran: ranTick, results, emailSync });
}
