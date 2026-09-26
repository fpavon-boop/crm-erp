import { NextRequest, NextResponse } from 'next/server';
import type { Role } from '@prisma/client';
import { requireAiModule } from '@/lib/ai/auth';
import { runAiSummaryFeature } from '@/lib/ai/service';
import { buildSalesSummaryFacts } from '@/lib/ai/facts';

/** AI-Assisted Features (docs/AI_FEATURES.md): aggregates the current
 * order pipeline, receivables, gross profit, and low-stock signal into a
 * plain-English sales summary + suggested next actions. Read-only —
 * reuses getDashboardData(), the same figures the Management Dashboard
 * shows, so it can never disagree with what's on screen. */
export async function POST(req: NextRequest) {
  const session = await requireAiModule('dashboard');
  if (session instanceof NextResponse) return session;
  void req;

  const facts = await buildSalesSummaryFacts(session.user.role as Role);

  const result = await runAiSummaryFeature({
    feature: 'SALES_SUMMARY',
    requestedById: session.user.id,
    facts,
    featureLabel: 'Sales Summary',
    instructions: 'Summarize the current sales/pipeline/revenue picture for a manager, and suggest what (if anything) deserves attention.',
  });

  return NextResponse.json(result);
}
