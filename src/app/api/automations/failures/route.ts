import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { requireCronSecret } from '@/lib/api-auth';
import { prisma } from '@/lib/prisma';

/**
 * Structured JSON view of failed automation jobs (Phase 13, requirement 4
 * "Admin Visibility" — docs/AUTOMATION_SYSTEM.md), for external
 * monitoring/alerting to poll rather than scrape the admin UI. Same
 * dual-auth pattern as POST /api/automations/run: either the shared cron
 * secret, or a signed-in ADMIN.
 */
export async function GET(req: NextRequest) {
  const cronError = requireCronSecret(req);
  if (cronError) {
    const session = await getServerSession(authOptions);
    if (!session?.user || session.user.role !== 'ADMIN') {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
  }

  const failures = await prisma.automationJobRun.findMany({
    where: { status: 'FAILED' },
    orderBy: { createdAt: 'desc' },
    take: 100,
    select: {
      id: true,
      jobKey: true,
      trigger: true,
      entityType: true,
      entityId: true,
      attempt: true,
      maxAttempts: true,
      errorMessage: true,
      startedAt: true,
      finishedAt: true,
      createdAt: true,
    },
  });

  return NextResponse.json({ count: failures.length, failures });
}
